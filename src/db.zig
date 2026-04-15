const std = @import("std");
const c = @cImport({
    @cInclude("sqlite3.h");
});

const Allocator = std.mem.Allocator;

pub const Db = struct {
    handle: *c.sqlite3,
    allocator: Allocator,
    path: []u8,

    pub fn open(allocator: Allocator) !Db {
        const db_path = try resolveDbPath(allocator);
        defer allocator.free(db_path);

        return openPath(allocator, db_path);
    }

    pub fn openAtPath(allocator: Allocator, db_path: []const u8) !Db {
        const duped = try allocator.dupeZ(u8, db_path);
        defer allocator.free(duped);
        return openPath(allocator, duped);
    }

    fn openPath(allocator: Allocator, db_path: [:0]const u8) !Db {
        var handle: ?*c.sqlite3 = null;
        if (c.sqlite3_open(db_path.ptr, &handle) != c.SQLITE_OK) {
            if (handle) |h| _ = c.sqlite3_close(h);
            return error.SqliteOpenFailed;
        }

        var db = Db{
            .handle = handle.?,
            .allocator = allocator,
            .path = try allocator.dupe(u8, db_path[0 .. db_path.len - 1]),
        };
        try db.migrate();
        return db;
    }

    pub fn close(self: *Db) void {
        _ = c.sqlite3_close(self.handle);
        self.allocator.free(self.path);
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

        if (version < 2) {
            // v2: Dedicated tasks and agents tables with bidirectional linking
            try self.execMulti(
                \\CREATE TABLE IF NOT EXISTS tasks (
                \\  id TEXT PRIMARY KEY,
                \\  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                \\  parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                \\  title TEXT NOT NULL DEFAULT '',
                \\  description TEXT NOT NULL DEFAULT '',
                \\  status TEXT NOT NULL DEFAULT 'todo',
                \\  priority TEXT NOT NULL DEFAULT 'medium',
                \\  queue_status TEXT NOT NULL DEFAULT 'none',
                \\  queued_at INTEGER,
                \\  dispatched_at INTEGER,
                \\  completed_at INTEGER,
                \\  assigned_agent_id TEXT,
                \\  node_id TEXT,
                \\  sort_order INTEGER NOT NULL DEFAULT 0,
                \\  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                \\);
                \\CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space_id);
                \\CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
                \\CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_status);
                \\
                \\CREATE TABLE IF NOT EXISTS agents (
                \\  id TEXT PRIMARY KEY,
                \\  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                \\  provider_id TEXT NOT NULL DEFAULT 'claude',
                \\  provider_name TEXT NOT NULL DEFAULT 'Claude Code',
                \\  status TEXT NOT NULL DEFAULT 'idle',
                \\  session_id TEXT,
                \\  assigned_task_id TEXT,
                \\  prompt TEXT,
                \\  started_at INTEGER,
                \\  node_id TEXT,
                \\  sort_order INTEGER NOT NULL DEFAULT 0,
                \\  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                \\);
                \\CREATE INDEX IF NOT EXISTS idx_agents_space ON agents(space_id);
                \\CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
                \\
                \\CREATE TABLE IF NOT EXISTS scheduler_settings (
                \\  workspace_id TEXT PRIMARY KEY,
                \\  concurrency INTEGER NOT NULL DEFAULT 4,
                \\  auto_dispatch INTEGER NOT NULL DEFAULT 1,
                \\  default_agent_id TEXT NOT NULL DEFAULT 'claude'
                \\);
            );

            // Add linking columns to nodes (SQLite ignores errors for existing columns)
            _ = c.sqlite3_exec(self.handle, "ALTER TABLE nodes ADD COLUMN task_id TEXT", null, null, null);
            _ = c.sqlite3_exec(self.handle, "ALTER TABLE nodes ADD COLUMN agent_id TEXT", null, null, null);
            _ = c.sqlite3_exec(self.handle, "ALTER TABLE nodes ADD COLUMN linked_node_id TEXT", null, null, null);

            // Migrate existing task_json/agent_json to new tables
            self.migrateJsonToTables();

            self.setUserVersion(2);
        }
    }

    fn migrateJsonToTables(self: *Db) void {
        // Migrate task_json from nodes to tasks table
        var task_stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, task_json FROM nodes WHERE task_json IS NOT NULL AND task_json != ''", -1, &task_stmt, null) == c.SQLITE_OK) {
            defer _ = c.sqlite3_finalize(task_stmt);

            while (c.sqlite3_step(task_stmt.?) == c.SQLITE_ROW) {
                const node_id = dupeColumnText(self.allocator, task_stmt.?, 0) catch continue;
                defer self.allocator.free(node_id);
                const space_id = dupeColumnText(self.allocator, task_stmt.?, 1) catch continue;
                defer self.allocator.free(space_id);
                const task_json_str = dupeColumnText(self.allocator, task_stmt.?, 2) catch continue;
                defer self.allocator.free(task_json_str);

                // Parse JSON and extract fields
                const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, task_json_str, .{}) catch continue;
                defer parsed.deinit();
                const obj = parsed.value.object;

                const title = if (obj.get("title")) |v| (if (v == .string) v.string else "") else "";
                const description = if (obj.get("description")) |v| (if (v == .string) v.string else "") else "";
                const status = if (obj.get("status")) |v| (if (v == .string) v.string else "todo") else "todo";
                const priority = if (obj.get("priority")) |v| (if (v == .string) v.string else "medium") else "medium";

                const task_id = std.fmt.allocPrint(self.allocator, "task-m-{s}", .{node_id}) catch continue;
                defer self.allocator.free(task_id);

                self.execBind(
                    "INSERT OR IGNORE INTO tasks (id, space_id, title, description, status, priority, node_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    .{ task_id, space_id, title, description, status, priority, node_id },
                ) catch continue;

                self.execBind("UPDATE nodes SET task_id = ?1 WHERE id = ?2", .{ task_id, node_id }) catch {};
            }
        }

        // Migrate agent_json from nodes to agents table
        var agent_stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, agent_json FROM nodes WHERE agent_json IS NOT NULL AND agent_json != ''", -1, &agent_stmt, null) == c.SQLITE_OK) {
            defer _ = c.sqlite3_finalize(agent_stmt);

            while (c.sqlite3_step(agent_stmt.?) == c.SQLITE_ROW) {
                const node_id = dupeColumnText(self.allocator, agent_stmt.?, 0) catch continue;
                defer self.allocator.free(node_id);
                const space_id = dupeColumnText(self.allocator, agent_stmt.?, 1) catch continue;
                defer self.allocator.free(space_id);
                const agent_json_str = dupeColumnText(self.allocator, agent_stmt.?, 2) catch continue;
                defer self.allocator.free(agent_json_str);

                const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, agent_json_str, .{}) catch continue;
                defer parsed.deinit();
                const obj = parsed.value.object;

                const provider_id = if (obj.get("providerId")) |v| (if (v == .string) v.string else "claude") else "claude";
                const provider_name = if (obj.get("providerName")) |v| (if (v == .string) v.string else "Claude Code") else "Claude Code";
                const prompt = if (obj.get("prompt")) |v| (if (v == .string) v.string else "") else "";
                const status = if (obj.get("status")) |v| (if (v == .string) v.string else "exited") else "exited";

                const agent_id = std.fmt.allocPrint(self.allocator, "agent-m-{s}", .{node_id}) catch continue;
                defer self.allocator.free(agent_id);

                self.execBind(
                    "INSERT OR IGNORE INTO agents (id, space_id, provider_id, provider_name, prompt, status, node_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    .{ agent_id, space_id, provider_id, provider_name, prompt, status, node_id },
                ) catch continue;

                self.execBind("UPDATE nodes SET agent_id = ?1 WHERE id = ?2", .{ agent_id, node_id }) catch {};
            }
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

    pub fn renameSpace(self: *Db, id: []const u8, name: []const u8) !void {
        try self.execBind("UPDATE spaces SET name = ?2 WHERE id = ?1", .{ id, name });
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
            "INSERT INTO node_scrollback (node_id, data) VALUES (?1, ?2) " ++
                "ON CONFLICT(node_id) DO UPDATE SET data = COALESCE(node_scrollback.data, '') || excluded.data",
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

    // -- Task CRUD --

    pub fn createTask(
        self: *Db,
        id: []const u8,
        space_id: []const u8,
        title: []const u8,
        description: []const u8,
        priority: []const u8,
        parent_task_id: ?[]const u8,
    ) !void {
        try self.execBind(
            "INSERT INTO tasks (id, space_id, title, description, priority, parent_task_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            .{ id, space_id, title, description, priority, parent_task_id },
        );
    }

    pub fn updateTask(
        self: *Db,
        id: []const u8,
        title: ?[]const u8,
        description: ?[]const u8,
        status: ?[]const u8,
        priority: ?[]const u8,
        queue_status: ?[]const u8,
    ) !void {
        // Build dynamic UPDATE statement
        if (title) |t| {
            try self.execBind("UPDATE tasks SET title = ?2 WHERE id = ?1", .{ id, t });
        }
        if (description) |d| {
            try self.execBind("UPDATE tasks SET description = ?2 WHERE id = ?1", .{ id, d });
        }
        if (status) |s| {
            try self.execBind("UPDATE tasks SET status = ?2 WHERE id = ?1", .{ id, s });
        }
        if (priority) |p| {
            try self.execBind("UPDATE tasks SET priority = ?2 WHERE id = ?1", .{ id, p });
        }
        if (queue_status) |q| {
            try self.execBind("UPDATE tasks SET queue_status = ?2 WHERE id = ?1", .{ id, q });
        }
    }

    pub fn deleteTask(self: *Db, id: []const u8) !void {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT assigned_agent_id FROM tasks WHERE id = ?1", -1, &stmt, null) != c.SQLITE_OK) return;
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, id);

        var agent_id: ?[]const u8 = null;
        if (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            agent_id = dupeColumnTextOpt(self.allocator, stmt.?, 0);
        }
        defer if (agent_id) |a| self.allocator.free(a);

        _ = c.sqlite3_exec(self.handle, "BEGIN TRANSACTION", null, null, null);
        errdefer _ = c.sqlite3_exec(self.handle, "ROLLBACK", null, null, null);

        if (agent_id) |aid| {
            try self.execBind(
                "UPDATE agents SET assigned_task_id = NULL, status = 'idle', session_id = NULL, started_at = NULL WHERE id = ?1",
                .{aid},
            );
        }

        try self.execBind("DELETE FROM tasks WHERE id = ?1", .{id});
        _ = c.sqlite3_exec(self.handle, "COMMIT", null, null, null);
    }

    pub fn listTasks(self: *Db, allocator: Allocator, space_id: []const u8, parent_task_id: ?[]const u8) ![]TaskRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (parent_task_id) |pid| {
            if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, parent_task_id, title, description, status, priority, queue_status, queued_at, dispatched_at, completed_at, assigned_agent_id, node_id, sort_order, created_at FROM tasks WHERE space_id = ?1 AND parent_task_id = ?2 ORDER BY sort_order", -1, &stmt, null) != c.SQLITE_OK) return &.{};
            bindText(stmt.?, 1, space_id);
            bindText(stmt.?, 2, pid);
        } else {
            if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, parent_task_id, title, description, status, priority, queue_status, queued_at, dispatched_at, completed_at, assigned_agent_id, node_id, sort_order, created_at FROM tasks WHERE space_id = ?1 AND parent_task_id IS NULL ORDER BY sort_order", -1, &stmt, null) != c.SQLITE_OK) return &.{};
            bindText(stmt.?, 1, space_id);
        }
        defer _ = c.sqlite3_finalize(stmt);

        var list: std.ArrayList(TaskRow) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            const row = TaskRow{
                .id = dupeColumnText(allocator, stmt.?, 0) catch continue,
                .space_id = dupeColumnText(allocator, stmt.?, 1) catch continue,
                .parent_task_id = dupeColumnTextOpt(allocator, stmt.?, 2),
                .title = dupeColumnText(allocator, stmt.?, 3) catch continue,
                .description = dupeColumnText(allocator, stmt.?, 4) catch continue,
                .status = dupeColumnText(allocator, stmt.?, 5) catch continue,
                .priority = dupeColumnText(allocator, stmt.?, 6) catch continue,
                .queue_status = dupeColumnText(allocator, stmt.?, 7) catch continue,
                .queued_at = if (c.sqlite3_column_type(stmt.?, 8) != c.SQLITE_NULL) c.sqlite3_column_int64(stmt.?, 8) else null,
                .dispatched_at = if (c.sqlite3_column_type(stmt.?, 9) != c.SQLITE_NULL) c.sqlite3_column_int64(stmt.?, 9) else null,
                .completed_at = if (c.sqlite3_column_type(stmt.?, 10) != c.SQLITE_NULL) c.sqlite3_column_int64(stmt.?, 10) else null,
                .assigned_agent_id = dupeColumnTextOpt(allocator, stmt.?, 11),
                .node_id = dupeColumnTextOpt(allocator, stmt.?, 12),
                .sort_order = c.sqlite3_column_int(stmt.?, 13),
                .created_at = c.sqlite3_column_int64(stmt.?, 14),
            };
            list.append(allocator, row) catch break;
        }
        return list.toOwnedSlice(allocator) catch &.{};
    }

    pub fn enqueueTask(self: *Db, id: []const u8) !void {
        try self.execBind(
            "UPDATE tasks SET queue_status = 'queued', queued_at = strftime('%s','now') WHERE id = ?1",
            .{id},
        );
    }

    pub fn assignTaskToAgent(self: *Db, task_id: []const u8, agent_id: []const u8) !void {
        // Begin transaction
        _ = c.sqlite3_exec(self.handle, "BEGIN TRANSACTION", null, null, null);
        errdefer _ = c.sqlite3_exec(self.handle, "ROLLBACK", null, null, null);

        // Update task
        try self.execBind(
            "UPDATE tasks SET assigned_agent_id = ?2, queue_status = 'dispatched', dispatched_at = strftime('%s','now'), status = 'in_progress' WHERE id = ?1",
            .{ task_id, agent_id },
        );

        // Update agent
        try self.execBind(
            "UPDATE agents SET assigned_task_id = ?2, status = 'running', started_at = strftime('%s','now') WHERE id = ?1",
            .{ agent_id, task_id },
        );

        _ = c.sqlite3_exec(self.handle, "COMMIT", null, null, null);
    }

    pub fn unassignTask(self: *Db, task_id: []const u8) !void {
        // Get assigned agent first
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT assigned_agent_id FROM tasks WHERE id = ?1", -1, &stmt, null) != c.SQLITE_OK) return;
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, task_id);

        var agent_id: ?[]const u8 = null;
        if (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            agent_id = dupeColumnTextOpt(self.allocator, stmt.?, 0);
        }
        defer if (agent_id) |a| self.allocator.free(a);

        // Begin transaction
        _ = c.sqlite3_exec(self.handle, "BEGIN TRANSACTION", null, null, null);
        errdefer _ = c.sqlite3_exec(self.handle, "ROLLBACK", null, null, null);

        // Clear task assignment
        try self.execBind(
            "UPDATE tasks SET assigned_agent_id = NULL, queue_status = 'completed', completed_at = strftime('%s','now'), status = 'done' WHERE id = ?1",
            .{task_id},
        );

        // Clear agent assignment
        if (agent_id) |aid| {
            try self.execBind(
                "UPDATE agents SET assigned_task_id = NULL, status = 'idle', session_id = NULL, started_at = NULL WHERE id = ?1",
                .{aid},
            );
        }

        _ = c.sqlite3_exec(self.handle, "COMMIT", null, null, null);
    }

    pub fn resetTaskDispatch(self: *Db, task_id: []const u8, requeue: bool) !void {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT assigned_agent_id FROM tasks WHERE id = ?1", -1, &stmt, null) != c.SQLITE_OK) return;
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, task_id);

        var agent_id: ?[]const u8 = null;
        if (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            agent_id = dupeColumnTextOpt(self.allocator, stmt.?, 0);
        }
        defer if (agent_id) |a| self.allocator.free(a);

        _ = c.sqlite3_exec(self.handle, "BEGIN TRANSACTION", null, null, null);
        errdefer _ = c.sqlite3_exec(self.handle, "ROLLBACK", null, null, null);

        if (requeue) {
            try self.execBind(
                "UPDATE tasks SET assigned_agent_id = NULL, status = 'todo', queue_status = 'queued', queued_at = strftime('%s','now'), dispatched_at = NULL, completed_at = NULL WHERE id = ?1",
                .{task_id},
            );
        } else {
            try self.execBind(
                "UPDATE tasks SET assigned_agent_id = NULL, status = 'todo', queue_status = 'none', queued_at = NULL, dispatched_at = NULL, completed_at = NULL WHERE id = ?1",
                .{task_id},
            );
        }

        if (agent_id) |aid| {
            try self.execBind(
                "UPDATE agents SET assigned_task_id = NULL, status = 'idle', session_id = NULL, started_at = NULL WHERE id = ?1",
                .{aid},
            );
        }

        _ = c.sqlite3_exec(self.handle, "COMMIT", null, null, null);
    }

    pub fn dispatchQueuedTasks(self: *Db, allocator: Allocator, space_id: []const u8) ![]DispatchAssignment {
        const queued_task_ids = try self.listQueuedTaskIdsForDispatch(allocator, space_id);
        defer freeIdRows(allocator, queued_task_ids);

        const idle_slot_ids = try self.listIdleSlotIdsForDispatch(allocator, space_id);
        defer freeIdRows(allocator, idle_slot_ids);

        const dispatch_count = @min(queued_task_ids.len, idle_slot_ids.len);
        if (dispatch_count == 0) return &.{};

        var assignments: std.ArrayList(DispatchAssignment) = .empty;
        defer assignments.deinit(allocator);

        for (0..dispatch_count) |index| {
            const task_id = queued_task_ids[index].id;
            const agent_id = idle_slot_ids[index].id;

            try self.assignTaskToAgent(task_id, agent_id);
            try assignments.append(allocator, .{
                .task_id = try allocator.dupe(u8, task_id),
                .agent_id = try allocator.dupe(u8, agent_id),
            });
        }

        return assignments.toOwnedSlice(allocator);
    }

    const IdRow = struct {
        id: []const u8,
    };

    fn listQueuedTaskIdsForDispatch(self: *Db, allocator: Allocator, space_id: []const u8) ![]IdRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(
            self.handle,
            "SELECT id FROM tasks WHERE space_id = ?1 AND queue_status = 'queued' AND assigned_agent_id IS NULL ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, COALESCE(queued_at, created_at), sort_order, created_at",
            -1,
            &stmt,
            null,
        ) != c.SQLITE_OK) return &.{};
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, space_id);

        var rows: std.ArrayList(IdRow) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            rows.append(allocator, .{
                .id = dupeColumnText(allocator, stmt.?, 0) catch continue,
            }) catch break;
        }
        return rows.toOwnedSlice(allocator) catch &.{};
    }

    fn listIdleSlotIdsForDispatch(self: *Db, allocator: Allocator, space_id: []const u8) ![]IdRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(
            self.handle,
            "SELECT id FROM agents WHERE space_id = ?1 AND id LIKE 'slot-%' AND status = 'idle' AND assigned_task_id IS NULL AND session_id IS NULL ORDER BY sort_order, created_at",
            -1,
            &stmt,
            null,
        ) != c.SQLITE_OK) return &.{};
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, space_id);

        var rows: std.ArrayList(IdRow) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            rows.append(allocator, .{
                .id = dupeColumnText(allocator, stmt.?, 0) catch continue,
            }) catch break;
        }
        return rows.toOwnedSlice(allocator) catch &.{};
    }

    // -- Agent CRUD --

    pub fn createAgent(
        self: *Db,
        id: []const u8,
        space_id: []const u8,
        provider_id: []const u8,
        provider_name: []const u8,
    ) !void {
        try self.execBind(
            "INSERT OR IGNORE INTO agents (id, space_id, provider_id, provider_name) VALUES (?1, ?2, ?3, ?4)",
            .{ id, space_id, provider_id, provider_name },
        );
    }

    pub fn updateAgent(
        self: *Db,
        id: []const u8,
        status: ?[]const u8,
        session_id: ?[]const u8,
        prompt: ?[]const u8,
        clear_session_id: bool,
        clear_assignment: bool,
    ) !void {
        if (status) |s| {
            try self.execBind("UPDATE agents SET status = ?2 WHERE id = ?1", .{ id, s });
        }
        if (session_id) |sid| {
            try self.execBind("UPDATE agents SET session_id = ?2 WHERE id = ?1", .{ id, sid });
        }
        if (prompt) |p| {
            try self.execBind("UPDATE agents SET prompt = ?2 WHERE id = ?1", .{ id, p });
        }
        if (clear_session_id) {
            try self.execBind("UPDATE agents SET session_id = NULL, started_at = NULL WHERE id = ?1", .{id});
        }
        if (clear_assignment) {
            try self.execBind("UPDATE agents SET assigned_task_id = NULL WHERE id = ?1", .{id});
        }
    }

    pub fn deleteAgent(self: *Db, id: []const u8) !void {
        try self.execBind("DELETE FROM agents WHERE id = ?1", .{id});
    }

    pub fn listAgents(self: *Db, allocator: Allocator, space_id: []const u8, status_filter: ?[]const u8) ![]AgentRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (status_filter) |sf| {
            if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, provider_id, provider_name, status, session_id, assigned_task_id, prompt, started_at, node_id, sort_order, created_at FROM agents WHERE space_id = ?1 AND status = ?2 ORDER BY sort_order", -1, &stmt, null) != c.SQLITE_OK) return &.{};
            bindText(stmt.?, 1, space_id);
            bindText(stmt.?, 2, sf);
        } else {
            if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, provider_id, provider_name, status, session_id, assigned_task_id, prompt, started_at, node_id, sort_order, created_at FROM agents WHERE space_id = ?1 ORDER BY sort_order", -1, &stmt, null) != c.SQLITE_OK) return &.{};
            bindText(stmt.?, 1, space_id);
        }
        defer _ = c.sqlite3_finalize(stmt);

        var list: std.ArrayList(AgentRow) = .empty;
        while (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            const row = AgentRow{
                .id = dupeColumnText(allocator, stmt.?, 0) catch continue,
                .space_id = dupeColumnText(allocator, stmt.?, 1) catch continue,
                .provider_id = dupeColumnText(allocator, stmt.?, 2) catch continue,
                .provider_name = dupeColumnText(allocator, stmt.?, 3) catch continue,
                .status = dupeColumnText(allocator, stmt.?, 4) catch continue,
                .session_id = dupeColumnTextOpt(allocator, stmt.?, 5),
                .assigned_task_id = dupeColumnTextOpt(allocator, stmt.?, 6),
                .prompt = dupeColumnTextOpt(allocator, stmt.?, 7),
                .started_at = if (c.sqlite3_column_type(stmt.?, 8) != c.SQLITE_NULL) c.sqlite3_column_int64(stmt.?, 8) else null,
                .node_id = dupeColumnTextOpt(allocator, stmt.?, 9),
                .sort_order = c.sqlite3_column_int(stmt.?, 10),
                .created_at = c.sqlite3_column_int64(stmt.?, 11),
            };
            list.append(allocator, row) catch break;
        }
        return list.toOwnedSlice(allocator) catch &.{};
    }

    pub fn getSessionAgentBinding(self: *Db, allocator: Allocator, session_id: []const u8) !?SessionAgentBinding {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT id, space_id, assigned_task_id FROM agents WHERE session_id = ?1 LIMIT 1", -1, &stmt, null) != c.SQLITE_OK) return null;
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, session_id);

        if (c.sqlite3_step(stmt.?) != c.SQLITE_ROW) return null;

        const agent_id = dupeColumnText(allocator, stmt.?, 0) catch return null;
        errdefer allocator.free(agent_id);
        const space_id = dupeColumnText(allocator, stmt.?, 1) catch return null;
        errdefer allocator.free(space_id);

        return SessionAgentBinding{
            .agent_id = agent_id,
            .space_id = space_id,
            .assigned_task_id = dupeColumnTextOpt(allocator, stmt.?, 2),
            .is_slot_agent = std.mem.startsWith(u8, agent_id, "slot-"),
        };
    }

    pub fn getTaskExecutionBinding(self: *Db, allocator: Allocator, task_id: []const u8) !?TaskExecutionBinding {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT t.space_id, t.assigned_agent_id, a.session_id FROM tasks t LEFT JOIN agents a ON t.assigned_agent_id = a.id WHERE t.id = ?1 LIMIT 1", -1, &stmt, null) != c.SQLITE_OK) return null;
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, task_id);

        if (c.sqlite3_step(stmt.?) != c.SQLITE_ROW) return null;

        const space_id = dupeColumnText(allocator, stmt.?, 0) catch return null;
        errdefer allocator.free(space_id);

        return TaskExecutionBinding{
            .space_id = space_id,
            .assigned_agent_id = dupeColumnTextOpt(allocator, stmt.?, 1),
            .session_id = dupeColumnTextOpt(allocator, stmt.?, 2),
        };
    }

    pub fn reconcileSlotDispatchState(self: *Db, allocator: Allocator, space_id: []const u8, requeue: bool) !void {
        const tasks_in_space = try self.listTasks(allocator, space_id, null);
        defer freeTaskRows(allocator, tasks_in_space);
        const agents_in_space = try self.listAgents(allocator, space_id, null);
        defer freeAgentRows(allocator, agents_in_space);

        var stale_task_ids = std.StringArrayHashMap(void).init(allocator);
        defer {
            var iterator = stale_task_ids.iterator();
            while (iterator.next()) |entry| {
                allocator.free(entry.key_ptr.*);
            }
            stale_task_ids.deinit();
        }

        for (tasks_in_space) |task| {
            if (task.assigned_agent_id) |agent_id| {
                if (std.mem.startsWith(u8, agent_id, "slot-") and
                    (std.mem.eql(u8, task.queue_status, "dispatched") or std.mem.eql(u8, task.status, "in_progress")))
                {
                    const task_id = try allocator.dupe(u8, task.id);
                    if (stale_task_ids.get(task_id) != null) {
                        allocator.free(task_id);
                    } else {
                        try stale_task_ids.put(task_id, {});
                    }
                }
            }
        }

        for (agents_in_space) |agent| {
            if (!std.mem.startsWith(u8, agent.id, "slot-")) continue;

            if (std.mem.eql(u8, agent.status, "running") and agent.assigned_task_id != null) {
                const task_id = try allocator.dupe(u8, agent.assigned_task_id.?);
                if (stale_task_ids.get(task_id) != null) {
                    allocator.free(task_id);
                } else {
                    try stale_task_ids.put(task_id, {});
                }
                continue;
            }

            if (std.mem.eql(u8, agent.status, "running") or agent.session_id != null or agent.assigned_task_id != null) {
                try self.updateAgent(agent.id, "idle", null, null, true, true);
            }
        }

        var iterator = stale_task_ids.iterator();
        while (iterator.next()) |entry| {
            try self.resetTaskDispatch(entry.key_ptr.*, requeue);
        }
    }

    // -- Scheduler Settings --

    pub fn getSchedulerSettings(self: *Db, allocator: Allocator, workspace_id: []const u8) !?SchedulerSettingsRow {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "SELECT workspace_id, concurrency, auto_dispatch, default_agent_id FROM scheduler_settings WHERE workspace_id = ?1", -1, &stmt, null) != c.SQLITE_OK) return null;
        defer _ = c.sqlite3_finalize(stmt);
        bindText(stmt.?, 1, workspace_id);

        if (c.sqlite3_step(stmt.?) == c.SQLITE_ROW) {
            return SchedulerSettingsRow{
                .workspace_id = dupeColumnText(allocator, stmt.?, 0) catch return null,
                .concurrency = c.sqlite3_column_int(stmt.?, 1),
                .auto_dispatch = c.sqlite3_column_int(stmt.?, 2) != 0,
                .default_agent_id = dupeColumnText(allocator, stmt.?, 3) catch return null,
            };
        }
        return null;
    }

    pub fn setSchedulerSettings(
        self: *Db,
        workspace_id: []const u8,
        concurrency: i32,
        auto_dispatch: bool,
        default_agent_id: []const u8,
    ) !void {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.handle, "INSERT OR REPLACE INTO scheduler_settings (workspace_id, concurrency, auto_dispatch, default_agent_id) VALUES (?1, ?2, ?3, ?4)", -1, &stmt, null) != c.SQLITE_OK) {
            return error.SqlitePrepareFailed;
        }
        defer _ = c.sqlite3_finalize(stmt);

        bindText(stmt.?, 1, workspace_id);
        _ = c.sqlite3_bind_int(stmt.?, 2, concurrency);
        _ = c.sqlite3_bind_int(stmt.?, 3, if (auto_dispatch) @as(c_int, 1) else @as(c_int, 0));
        bindText(stmt.?, 4, default_agent_id);

        if (c.sqlite3_step(stmt.?) != c.SQLITE_DONE) {
            return error.SqliteStepFailed;
        }
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

pub const TaskRow = struct {
    id: []const u8,
    space_id: []const u8,
    parent_task_id: ?[]const u8,
    title: []const u8,
    description: []const u8,
    status: []const u8,
    priority: []const u8,
    queue_status: []const u8,
    queued_at: ?i64,
    dispatched_at: ?i64,
    completed_at: ?i64,
    assigned_agent_id: ?[]const u8,
    node_id: ?[]const u8,
    sort_order: i32,
    created_at: i64,
};

pub const AgentRow = struct {
    id: []const u8,
    space_id: []const u8,
    provider_id: []const u8,
    provider_name: []const u8,
    status: []const u8,
    session_id: ?[]const u8,
    assigned_task_id: ?[]const u8,
    prompt: ?[]const u8,
    started_at: ?i64,
    node_id: ?[]const u8,
    sort_order: i32,
    created_at: i64,
};

pub const DispatchAssignment = struct {
    task_id: []const u8,
    agent_id: []const u8,
};

pub const SessionAgentBinding = struct {
    agent_id: []const u8,
    space_id: []const u8,
    assigned_task_id: ?[]const u8,
    is_slot_agent: bool,
};

pub const TaskExecutionBinding = struct {
    space_id: []const u8,
    assigned_agent_id: ?[]const u8,
    session_id: ?[]const u8,
};

pub const SchedulerSettingsRow = struct {
    workspace_id: []const u8,
    concurrency: i32,
    auto_dispatch: bool,
    default_agent_id: []const u8,
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
    const configured = try loadConfiguredDbPath(allocator);
    defer allocator.free(configured);
    return try allocator.dupeZ(u8, configured);
}

pub fn ensureWorkspaceDbRoot(allocator: Allocator) ![]u8 {
    const home = std.posix.getenv("HOME") orelse "/tmp";
    const dir = try std.fs.path.join(allocator, &.{ home, ".nexus", "workspaces" });
    errdefer allocator.free(dir);
    std.fs.cwd().makePath(dir) catch {};
    return dir;
}

fn defaultWorkspaceDbPath(allocator: Allocator) ![]u8 {
    const root = try ensureWorkspaceDbRoot(allocator);
    defer allocator.free(root);
    return std.fs.path.join(allocator, &.{ root, "default.nexus.db" });
}

fn currentWorkspaceConfigPath(allocator: Allocator) ![]u8 {
    const home = std.posix.getenv("HOME") orelse "/tmp";
    const dir = try std.fs.path.join(allocator, &.{ home, ".nexus" });
    defer allocator.free(dir);
    std.fs.cwd().makePath(dir) catch {};
    return std.fs.path.join(allocator, &.{ dir, "current-workspace-path.txt" });
}

fn loadConfiguredDbPath(allocator: Allocator) ![]u8 {
    const config_path = try currentWorkspaceConfigPath(allocator);
    defer allocator.free(config_path);

    const file = std.fs.openFileAbsolute(config_path, .{}) catch return defaultWorkspaceDbPath(allocator);
    defer file.close();

    const raw = try file.readToEndAlloc(allocator, 4096);
    defer allocator.free(raw);

    const trimmed = std.mem.trim(u8, raw, " \r\n\t");
    if (trimmed.len == 0) {
        return defaultWorkspaceDbPath(allocator);
    }
    return allocator.dupe(u8, trimmed);
}

pub fn saveConfiguredDbPath(allocator: Allocator, path: []const u8) !void {
    const config_path = try currentWorkspaceConfigPath(allocator);
    defer allocator.free(config_path);

    var file = try std.fs.createFileAbsolute(config_path, .{ .truncate = true });
    defer file.close();
    try file.writeAll(path);
}

pub fn createManagedWorkspaceDbPath(allocator: Allocator, preferred_name: []const u8) ![]u8 {
    const root = try ensureWorkspaceDbRoot(allocator);
    defer allocator.free(root);

    var sanitized: [96]u8 = undefined;
    var len: usize = 0;
    for (preferred_name) |ch| {
        if (len == sanitized.len) break;
        if (std.ascii.isAlphanumeric(ch)) {
            sanitized[len] = std.ascii.toLower(ch);
            len += 1;
        } else if ((ch == '-' or ch == '_' or ch == '.') and len > 0) {
            sanitized[len] = ch;
            len += 1;
        } else if (len > 0 and sanitized[len - 1] != '-') {
            sanitized[len] = '-';
            len += 1;
        }
    }
    const base_name = std.mem.trimRight(u8, sanitized[0..len], "-.");
    const file_name = if (base_name.len > 0)
        try std.fmt.allocPrint(allocator, "{d}-{s}.nexus.db", .{ std.time.timestamp(), base_name })
    else
        try std.fmt.allocPrint(allocator, "{d}-workspace.nexus.db", .{std.time.timestamp()});
    defer allocator.free(file_name);

    return std.fs.path.join(allocator, &.{ root, file_name });
}

fn uniqueTestDbPath(allocator: Allocator) ![:0]u8 {
    return std.fmt.allocPrintSentinel(
        allocator,
        "/tmp/nexus-db-test-{d}.sqlite",
        .{std.time.nanoTimestamp()},
        0,
    );
}

fn freeWorkspaceRows(allocator: Allocator, rows: []WorkspaceRow) void {
    for (rows) |row| {
        allocator.free(row.id);
        allocator.free(row.name);
        allocator.free(row.path);
        if (row.active_space_id) |value| allocator.free(value);
    }
    allocator.free(rows);
}

fn freeSpaceRows(allocator: Allocator, rows: []SpaceRow) void {
    for (rows) |row| {
        allocator.free(row.id);
        allocator.free(row.workspace_id);
        allocator.free(row.name);
        allocator.free(row.directory_path);
        if (row.label_color) |value| allocator.free(value);
    }
    allocator.free(rows);
}

fn freeTaskRows(allocator: Allocator, rows: []TaskRow) void {
    for (rows) |row| {
        allocator.free(row.id);
        allocator.free(row.space_id);
        if (row.parent_task_id) |value| allocator.free(value);
        allocator.free(row.title);
        allocator.free(row.description);
        allocator.free(row.status);
        allocator.free(row.priority);
        allocator.free(row.queue_status);
        if (row.assigned_agent_id) |value| allocator.free(value);
        if (row.node_id) |value| allocator.free(value);
    }
    allocator.free(rows);
}

fn freeAgentRows(allocator: Allocator, rows: []AgentRow) void {
    for (rows) |row| {
        allocator.free(row.id);
        allocator.free(row.space_id);
        allocator.free(row.provider_id);
        allocator.free(row.provider_name);
        allocator.free(row.status);
        if (row.session_id) |value| allocator.free(value);
        if (row.assigned_task_id) |value| allocator.free(value);
        if (row.prompt) |value| allocator.free(value);
        if (row.node_id) |value| allocator.free(value);
    }
    allocator.free(rows);
}

pub fn freeDispatchAssignments(allocator: Allocator, rows: []DispatchAssignment) void {
    for (rows) |row| {
        allocator.free(row.task_id);
        allocator.free(row.agent_id);
    }
    allocator.free(rows);
}

fn freeIdRows(allocator: Allocator, rows: []Db.IdRow) void {
    for (rows) |row| {
        allocator.free(row.id);
    }
    allocator.free(rows);
}

pub fn freeSessionAgentBinding(allocator: Allocator, binding: SessionAgentBinding) void {
    allocator.free(binding.agent_id);
    allocator.free(binding.space_id);
    if (binding.assigned_task_id) |value| allocator.free(value);
}

pub fn freeTaskExecutionBinding(allocator: Allocator, binding: TaskExecutionBinding) void {
    allocator.free(binding.space_id);
    if (binding.assigned_agent_id) |value| allocator.free(value);
    if (binding.session_id) |value| allocator.free(value);
}

test "Db persists workspaces, spaces, and scheduler settings across reopen" {
    const allocator = std.testing.allocator;
    const db_path = try uniqueTestDbPath(allocator);
    defer allocator.free(db_path);
    defer std.fs.cwd().deleteFile(std.mem.sliceTo(db_path, 0)) catch {};

    {
        var db = try Db.openPath(allocator, db_path);
        defer db.close();

        try db.createWorkspace("ws-1", "Workspace", "/repo");
        try db.createSpace("space-1", "ws-1", "Default", "/repo");
        try db.setSchedulerSettings("ws-1", 3, true, "claude");
    }

    {
        var reopened = try Db.openPath(allocator, db_path);
        defer reopened.close();

        const workspaces = try reopened.listWorkspaces(allocator);
        defer freeWorkspaceRows(allocator, workspaces);
        try std.testing.expectEqual(@as(usize, 1), workspaces.len);
        try std.testing.expectEqualStrings("ws-1", workspaces[0].id);
        try std.testing.expectEqualStrings("/repo", workspaces[0].path);

        const spaces = try reopened.listSpaces(allocator, "ws-1");
        defer freeSpaceRows(allocator, spaces);
        try std.testing.expectEqual(@as(usize, 1), spaces.len);
        try std.testing.expectEqualStrings("space-1", spaces[0].id);
        try std.testing.expectEqualStrings("Default", spaces[0].name);

        const settings = (try reopened.getSchedulerSettings(allocator, "ws-1")).?;
        defer {
            allocator.free(settings.workspace_id);
            allocator.free(settings.default_agent_id);
        }
        try std.testing.expectEqual(@as(i32, 3), settings.concurrency);
        try std.testing.expect(settings.auto_dispatch);
        try std.testing.expectEqualStrings("claude", settings.default_agent_id);
    }
}

test "Db persists task queue assignment and agent linkage" {
    const allocator = std.testing.allocator;
    const db_path = try uniqueTestDbPath(allocator);
    defer allocator.free(db_path);
    defer std.fs.cwd().deleteFile(std.mem.sliceTo(db_path, 0)) catch {};

    var db = try Db.openPath(allocator, db_path);
    defer db.close();

    try db.createWorkspace("ws-1", "Workspace", "/repo");
    try db.createSpace("space-1", "ws-1", "Default", "/repo");
    try db.createTask("task-1", "space-1", "Test persistence", "Verify dispatch", "high", null);
    try db.createAgent("slot-1", "space-1", "claude", "Claude Code");
    try db.enqueueTask("task-1");
    try db.assignTaskToAgent("task-1", "slot-1");

    const tasks_list = try db.listTasks(allocator, "space-1", null);
    defer freeTaskRows(allocator, tasks_list);
    try std.testing.expectEqual(@as(usize, 1), tasks_list.len);
    try std.testing.expectEqualStrings("dispatched", tasks_list[0].queue_status);
    try std.testing.expectEqualStrings("in_progress", tasks_list[0].status);
    try std.testing.expect(tasks_list[0].queued_at != null);
    try std.testing.expect(tasks_list[0].dispatched_at != null);
    try std.testing.expectEqualStrings("slot-1", tasks_list[0].assigned_agent_id.?);

    const agents_list = try db.listAgents(allocator, "space-1", null);
    defer freeAgentRows(allocator, agents_list);
    try std.testing.expectEqual(@as(usize, 1), agents_list.len);
    try std.testing.expectEqualStrings("running", agents_list[0].status);
    try std.testing.expectEqualStrings("task-1", agents_list[0].assigned_task_id.?);
    try std.testing.expect(agents_list[0].started_at != null);
}

test "Db dispatches queued tasks to idle slot agents by priority" {
    const allocator = std.testing.allocator;
    const db_path = try uniqueTestDbPath(allocator);
    defer allocator.free(db_path);
    defer std.fs.cwd().deleteFile(std.mem.sliceTo(db_path, 0)) catch {};

    var db = try Db.openPath(allocator, db_path);
    defer db.close();

    try db.createWorkspace("ws-1", "Workspace", "/repo");
    try db.createSpace("space-1", "ws-1", "Default", "/repo");

    try db.createTask("task-low", "space-1", "Low", "Low priority", "low", null);
    try db.createTask("task-high", "space-1", "High", "High priority", "high", null);
    try db.enqueueTask("task-low");
    try db.enqueueTask("task-high");

    try db.createAgent("slot-1", "space-1", "claude", "Claude Code");
    try db.createAgent("slot-2", "space-1", "claude", "Claude Code");
    try db.createAgent("agent-1", "space-1", "claude", "Claude Code");

    const assignments = try db.dispatchQueuedTasks(allocator, "space-1");
    defer freeDispatchAssignments(allocator, assignments);

    try std.testing.expectEqual(@as(usize, 2), assignments.len);
    try std.testing.expectEqualStrings("task-high", assignments[0].task_id);
    try std.testing.expectEqualStrings("slot-1", assignments[0].agent_id);
    try std.testing.expectEqualStrings("task-low", assignments[1].task_id);
    try std.testing.expectEqualStrings("slot-2", assignments[1].agent_id);

    const tasks_list = try db.listTasks(allocator, "space-1", null);
    defer freeTaskRows(allocator, tasks_list);
    var low_task_agent_id: ?[]const u8 = null;
    var high_task_agent_id: ?[]const u8 = null;
    for (tasks_list) |task| {
        if (std.mem.eql(u8, task.id, "task-low")) low_task_agent_id = task.assigned_agent_id;
        if (std.mem.eql(u8, task.id, "task-high")) high_task_agent_id = task.assigned_agent_id;
    }
    try std.testing.expectEqualStrings("slot-2", low_task_agent_id.?);
    try std.testing.expectEqualStrings("slot-1", high_task_agent_id.?);
}
