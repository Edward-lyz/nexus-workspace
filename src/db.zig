const std = @import("std");
const c = @cImport({
    @cInclude("sqlite3.h");
});

const Allocator = std.mem.Allocator;

pub const Db = struct {
    handle: *c.sqlite3,
    allocator: Allocator,

    pub fn open(allocator: Allocator) !Db {
        const db_path = try resolveDbPath(allocator);
        defer allocator.free(db_path);

        var handle: ?*c.sqlite3 = null;
        if (c.sqlite3_open(db_path.ptr, &handle) != c.SQLITE_OK) {
            if (handle) |h| _ = c.sqlite3_close(h);
            return error.SqliteOpenFailed;
        }

        var db = Db{ .handle = handle.?, .allocator = allocator };
        try db.migrate();
        return db;
    }

    pub fn close(self: *Db) void {
        _ = c.sqlite3_close(self.handle);
    }

    // -- Schema migration --

    fn migrate(self: *Db) !void {
        const version = self.getUserVersion();

        if (version < 1) {
            try self.execMulti(
                \\CREATE TABLE IF NOT EXISTS workspaces (
                \\  id TEXT PRIMARY KEY,
                \\  name TEXT NOT NULL,
                \\  path TEXT NOT NULL DEFAULT '',
                \\  active_space_id TEXT,
                \\  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                \\);
                \\
                \\CREATE TABLE IF NOT EXISTS spaces (
                \\  id TEXT PRIMARY KEY,
                \\  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                \\  name TEXT NOT NULL,
                \\  directory_path TEXT NOT NULL DEFAULT '',
                \\  label_color TEXT,
                \\  sort_order INTEGER NOT NULL DEFAULT 0
                \\);
                \\
                \\CREATE TABLE IF NOT EXISTS nodes (
                \\  id TEXT PRIMARY KEY,
                \\  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                \\  kind TEXT NOT NULL DEFAULT 'terminal',
                \\  title TEXT NOT NULL DEFAULT '',
                \\  session_id TEXT,
                \\  agent_json TEXT,
                \\  task_json TEXT,
                \\  sort_order INTEGER NOT NULL DEFAULT 0,
                \\  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                \\);
                \\
                \\CREATE TABLE IF NOT EXISTS node_scrollback (
                \\  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                \\  data TEXT NOT NULL DEFAULT ''
                \\);
                \\
                \\CREATE TABLE IF NOT EXISTS app_settings (
                \\  key TEXT PRIMARY KEY,
                \\  value TEXT NOT NULL
                \\);
            );
            self.setUserVersion(1);
        }
    }

    fn getUserVersion(self: *Db) i32 {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "PRAGMA user_version", -1, &stmt, null) != c.SQLITE_OK) return 0;
        defer _ = c.sqlite3_finalize(stmt);
        if (c.sqlite3_step(stmt.?) != c.SQLITE_ROW) return 0;
        return c.sqlite3_column_int(stmt.?, 0);
    }

    fn setUserVersion(self: *Db, ver: i32) void {
        var buf: [64]u8 = undefined;
        const sql = std.fmt.bufPrint(&buf, "PRAGMA user_version = {d}", .{ver}) catch return;
        // Null-terminate for sqlite3
        var z: [65]u8 = undefined;
        @memcpy(z[0..sql.len], sql);
        z[sql.len] = 0;
        _ = c.sqlite3_exec(self.handle, &z, null, null, null);
    }

    // -- Workspace CRUD --

    pub fn listWorkspaces(self: *Db, allocator: Allocator) ![]WorkspaceRow {
        return self.queryAll(WorkspaceRow, allocator,
            "SELECT id, name, path, active_space_id FROM workspaces ORDER BY created_at",
        );
    }

    pub fn createWorkspace(self: *Db, id: []const u8, name: []const u8, path: []const u8) !void {
        try self.execBind(
            "INSERT INTO workspaces (id, name, path) VALUES (?1, ?2, ?3)",
            .{ id, name, path },
        );
    }

    pub fn updateWorkspaceActiveSpace(self: *Db, workspace_id: []const u8, space_id: ?[]const u8) !void {
        try self.execBind(
            "UPDATE workspaces SET active_space_id = ?2 WHERE id = ?1",
            .{ workspace_id, space_id },
        );
    }

    pub fn updateWorkspacePath(self: *Db, workspace_id: []const u8, path: []const u8) !void {
        try self.execBind(
            "UPDATE workspaces SET path = ?2 WHERE id = ?1",
            .{ workspace_id, path },
        );
    }

    pub fn getWorkspacePath(self: *Db, allocator: Allocator, workspace_id: []const u8) ![]const u8 {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT path FROM workspaces WHERE id = ?1", -1, &stmt, null) != c.SQLITE_OK) {
            return allocator.dupe(u8, "");
        }
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, workspace_id);
        if (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            return dupeColumnText(allocator, stmt.?, 0);
        }
        return allocator.dupe(u8, "");
    }

    pub fn deleteWorkspace(self: *Db, id: []const u8) !void {
        try self.execBind("DELETE FROM workspaces WHERE id = ?1", .{id});
    }

    // -- Space CRUD --

    pub fn listSpaces(self: *Db, allocator: Allocator, workspace_id: []const u8) ![]SpaceRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT id, workspace_id, name, directory_path, label_color, sort_order FROM spaces WHERE workspace_id = ?1 ORDER BY sort_order", -1, &stmt, null) != c.SQLITE_OK) return &.{};
        defer _ = c.sqlite3_finalize(stmt);

        bindText(stmt.?, 1, workspace_id);

        var list: std.ArrayList(SpaceRow) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            const row = SpaceRow{
                .id = dupeColumnText(allocator, stmt.?, 0) catch continue,
                .workspace_id = dupeColumnText(allocator, stmt.?, 1) catch continue,
                .name = dupeColumnText(allocator, stmt.?, 2) catch continue,
                .directory_path = dupeColumnText(allocator, stmt.?, 3) catch continue,
                .label_color = dupeColumnTextOpt(allocator, stmt.?, 4),
                .sort_order = c.sqlite3_column_int(stmt.?, 5),
            };
            list.append(allocator, row) catch break;
        }
        return list.toOwnedSlice(allocator) catch &.{};
    }

    pub fn createSpace(self: *Db, id: []const u8, workspace_id: []const u8, name: []const u8, dir_path: []const u8) !void {
        try self.execBind(
            "INSERT INTO spaces (id, workspace_id, name, directory_path) VALUES (?1, ?2, ?3, ?4)",
            .{ id, workspace_id, name, dir_path },
        );
    }

    pub fn deleteSpace(self: *Db, id: []const u8) !void {
        try self.execBind("DELETE FROM spaces WHERE id = ?1", .{id});
    }

    // -- Node CRUD --

    pub fn createNode(self: *Db, id: []const u8, space_id: []const u8, kind: []const u8, title: []const u8) !void {
        try self.execBind(
            "INSERT INTO nodes (id, space_id, kind, title) VALUES (?1, ?2, ?3, ?4)",
            .{ id, space_id, kind, title },
        );
    }

    pub fn updateNodeSession(self: *Db, node_id: []const u8, session_id: []const u8) !void {
        try self.execBind(
            "UPDATE nodes SET session_id = ?2 WHERE id = ?1",
            .{ node_id, session_id },
        );
    }

    pub fn updateNodeAgent(self: *Db, node_id: []const u8, agent_json: []const u8) !void {
        try self.execBind(
            "UPDATE nodes SET agent_json = ?2 WHERE id = ?1",
            .{ node_id, agent_json },
        );
    }

    pub fn deleteNode(self: *Db, id: []const u8) !void {
        try self.execBind("DELETE FROM nodes WHERE id = ?1", .{id});
    }

    // -- Node list/update additions --

    pub fn listNodes(self: *Db, allocator: Allocator, space_id: []const u8) ![]NodeRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, kind, title, session_id, agent_json, task_json, sort_order FROM nodes WHERE space_id = ?1 ORDER BY sort_order", -1, &stmt, null) != c.SQLITE_OK) return &.{};
        defer _ = c.sqlite3_finalize(stmt);

        bindText(stmt.?, 1, space_id);

        var list: std.ArrayList(NodeRow) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            const row = NodeRow{
                .id = dupeColumnText(allocator, stmt.?, 0) catch continue,
                .space_id = dupeColumnText(allocator, stmt.?, 1) catch continue,
                .kind = dupeColumnText(allocator, stmt.?, 2) catch continue,
                .title = dupeColumnText(allocator, stmt.?, 3) catch continue,
                .session_id = dupeColumnTextOpt(allocator, stmt.?, 4),
                .agent_json = dupeColumnTextOpt(allocator, stmt.?, 5),
                .task_json = dupeColumnTextOpt(allocator, stmt.?, 6),
                .sort_order = c.sqlite3_column_int(stmt.?, 7),
            };
            list.append(allocator, row) catch break;
        }
        return list.toOwnedSlice(allocator) catch &.{};
    }

    pub fn updateNodeTask(self: *Db, node_id: []const u8, task_json: []const u8) !void {
        try self.execBind(
            "UPDATE nodes SET task_json = ?2 WHERE id = ?1",
            .{ node_id, task_json },
        );
    }

    pub fn updateNodeTitle(self: *Db, node_id: []const u8, title: []const u8) !void {
        try self.execBind(
            "UPDATE nodes SET title = ?2 WHERE id = ?1",
            .{ node_id, title },
        );
    }

    // -- Scrollback --

    pub fn saveScrollback(self: *Db, node_id: []const u8, data: []const u8) !void {
        try self.execBind(
            "INSERT OR REPLACE INTO node_scrollback (node_id, data) VALUES (?1, ?2)",
            .{ node_id, data },
        );
    }

    pub fn loadScrollback(self: *Db, allocator: Allocator, node_id: []const u8) !?[]u8 {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT data FROM node_scrollback WHERE node_id = ?1", -1, &stmt, null) != c.SQLITE_OK) return null;
        defer _ = c.sqlite3_finalize(stmt);

        bindText(stmt.?, 1, node_id);
        if (c.sqlite3_step(stmt.?) != c.SQLITE_ROW) return null;

        const ptr = c.sqlite3_column_text(stmt.?, 0);
        const len: usize = @intCast(c.sqlite3_column_bytes(stmt.?, 0));
        if (ptr == null or len == 0) return null;

        const result = try allocator.alloc(u8, len);
        @memcpy(result, ptr[0..len]);
        return result;
    }

    // -- Settings --

    pub fn getSetting(self: *Db, allocator: Allocator, key: []const u8) !?[]u8 {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT value FROM app_settings WHERE key = ?1", -1, &stmt, null) != c.SQLITE_OK) return null;
        defer _ = c.sqlite3_finalize(stmt);

        bindText(stmt.?, 1, key);
        if (c.sqlite3_step(stmt.?) != c.SQLITE_ROW) return null;

        const ptr = c.sqlite3_column_text(stmt.?, 0);
        const len: usize = @intCast(c.sqlite3_column_bytes(stmt.?, 0));
        if (ptr == null or len == 0) return null;

        const result = try allocator.alloc(u8, len);
        @memcpy(result, ptr[0..len]);
        return result;
    }

    pub fn setSetting(self: *Db, key: []const u8, value: []const u8) !void {
        try self.execBind(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            .{ key, value },
        );
    }

    // -- Helpers --

    fn execMulti(self: *Db, sql: [*:0]const u8) !void {
        var errmsg: [*c]u8 = null;
        if (c.sqlite3_exec(self.handle, sql, null, null, &errmsg) != c.SQLITE_OK) {
            if (errmsg != null) {
                std.log.err("sqlite exec: {s}", .{errmsg});
                c.sqlite3_free(errmsg);
            }
            return error.SqliteExecFailed;
        }
    }

    fn execBind(self: *Db, sql: [*:0]const u8, args: anytype) !void {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, sql, -1, &stmt, null) != c.SQLITE_OK) {
            return error.SqlitePrepareFailed;
        }
        defer _ = c.sqlite3_finalize(stmt);

        inline for (args, 0..) |arg, i| {
            const col: c_int = @intCast(i + 1);
            const T = @TypeOf(arg);
            if (T == @TypeOf(null)) {
                _ = c.sqlite3_bind_null(stmt.?, col);
            } else if (@typeInfo(T) == .optional) {
                if (arg) |val| {
                    bindText(stmt.?, col, val);
                } else {
                    _ = c.sqlite3_bind_null(stmt.?, col);
                }
            } else {
                bindText(stmt.?, col, arg);
            }
        }

        if (c.sqlite3_step(stmt.?) != c.SQLITE_DONE) {
            return error.SqliteStepFailed;
        }
    }

    fn queryAll(self: *Db, comptime T: type, allocator: Allocator, sql: [*:0]const u8) ![]T {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, sql, -1, &stmt, null) != c.SQLITE_OK) {
            return &.{};
        }
        defer _ = c.sqlite3_finalize(stmt);

        var list: std.ArrayList(T) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            const row = T.fromRow(allocator, stmt.?) catch continue;
            list.append(allocator, row) catch break;
        }
        return list.toOwnedSlice(allocator) catch &.{};
    }
};

// -- Row types --

pub const WorkspaceRow = struct {
    id: []const u8,
    name: []const u8,
    path: []const u8,
    active_space_id: ?[]const u8,

    fn fromRow(allocator: Allocator, stmt: *c.sqlite3_stmt) !WorkspaceRow {
        return .{
            .id = try dupeColumnText(allocator, stmt, 0),
            .name = try dupeColumnText(allocator, stmt, 1),
            .path = try dupeColumnText(allocator, stmt, 2),
            .active_space_id = dupeColumnTextOpt(allocator, stmt, 3),
        };
    }
};

pub const SpaceRow = struct {
    id: []const u8,
    workspace_id: []const u8,
    name: []const u8,
    directory_path: []const u8,
    label_color: ?[]const u8,
    sort_order: i32,
};

pub const NodeRow = struct {
    id: []const u8,
    space_id: []const u8,
    kind: []const u8,
    title: []const u8,
    session_id: ?[]const u8,
    agent_json: ?[]const u8,
    task_json: ?[]const u8,
    sort_order: i32,
};

// -- Low-level helpers --

fn bindText(stmt: *c.sqlite3_stmt, col: c_int, text: []const u8) void {
    // Use SQLITE_STATIC (null) — bound text outlives sqlite3_step in our usage
    _ = c.sqlite3_bind_text(stmt, col, text.ptr, @intCast(text.len), null);
}

fn dupeColumnText(allocator: Allocator, stmt: *c.sqlite3_stmt, col: c_int) ![]const u8 {
    const ptr = c.sqlite3_column_text(stmt, col);
    const len: usize = @intCast(c.sqlite3_column_bytes(stmt, col));
    if (ptr == null or len == 0) return try allocator.dupe(u8, "");
    const result = try allocator.alloc(u8, len);
    @memcpy(result, ptr[0..len]);
    return result;
}

fn dupeColumnTextOpt(allocator: Allocator, stmt: *c.sqlite3_stmt, col: c_int) ?[]const u8 {
    const ptr = c.sqlite3_column_text(stmt, col);
    const len: usize = @intCast(c.sqlite3_column_bytes(stmt, col));
    if (ptr == null or len == 0) return null;
    const result = allocator.alloc(u8, len) catch return null;
    @memcpy(result, ptr[0..len]);
    return result;
}

fn resolveDbPath(allocator: Allocator) ![:0]u8 {
    const home = std.posix.getenv("HOME") orelse "/tmp";
    const dir = try std.fs.path.join(allocator, &.{ home, ".cove" });
    defer allocator.free(dir);

    // Ensure directory exists
    std.fs.cwd().makePath(dir) catch {};

    const path = try std.fs.path.join(allocator, &.{ dir, "cove.db" });
    defer allocator.free(path);

    // Return null-terminated copy
    return try allocator.dupeZ(u8, path);
}
