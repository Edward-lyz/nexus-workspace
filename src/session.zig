const std = @import("std");
const pty = @import("pty.zig");

pub const SessionKind = enum {
    shell,
    agent,
};

pub const SessionStatus = enum {
    running,
    exited,
    failed,
};

pub const Session = struct {
    id: []const u8,
    pty_handle: pty.PtyHandle,
    kind: SessionKind,
    space_id: ?[]const u8,
    node_id: ?[]const u8,
    status: SessionStatus,
    exit_code: ?i32,
    started_at: i64,
};

pub const SessionManager = struct {
    allocator: std.mem.Allocator,
    sessions: std.StringArrayHashMap(Session),
    next_id: u32 = 1,

    pub fn init(allocator: std.mem.Allocator) SessionManager {
        return .{
            .allocator = allocator,
            .sessions = .init(allocator),
        };
    }

    pub fn deinit(self: *SessionManager) void {
        var it = self.sessions.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.status == .running) {
                entry.value_ptr.pty_handle.kill();
            }
            self.allocator.free(entry.key_ptr.*);
        }
        self.sessions.deinit();
    }

    pub fn spawn(
        self: *SessionManager,
        kind: SessionKind,
        cwd: ?[]const u8,
        command: ?[]const u8,
        space_id: ?[]const u8,
        node_id: ?[]const u8,
    ) !*Session {
        const handle = try pty.spawn(self.allocator, cwd, 80, 24, command);

        const session_id = try std.fmt.allocPrint(self.allocator, "s{d}", .{self.next_id});
        self.next_id += 1;

        const now = std.time.timestamp();

        try self.sessions.put(session_id, .{
            .id = session_id,
            .pty_handle = handle,
            .kind = kind,
            .space_id = space_id,
            .node_id = node_id,
            .status = .running,
            .exit_code = null,
            .started_at = now,
        });

        return self.sessions.getPtr(session_id).?;
    }

    pub fn get(self: *SessionManager, id: []const u8) ?*Session {
        return self.sessions.getPtr(id);
    }

    pub fn kill(self: *SessionManager, id: []const u8) void {
        if (self.sessions.getPtr(id)) |session| {
            if (session.status == .running) {
                session.pty_handle.kill();
                session.status = .exited;
            }
        }
    }

    pub fn markExited(self: *SessionManager, id: []const u8, exit_code: ?i32) void {
        if (self.sessions.getPtr(id)) |session| {
            session.status = .exited;
            session.exit_code = exit_code;
        }
    }

    pub fn iterator(self: *SessionManager) std.StringArrayHashMap(Session).Iterator {
        return self.sessions.iterator();
    }
};
