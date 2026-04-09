const std = @import("std");
const posix = std.posix;
const session_mod = @import("session.zig");
const db_mod = @import("db.zig");
const notify = @import("notify.zig");
const macos = @import("macos.zig");

const Allocator = std.mem.Allocator;

pub const Server = struct {
    allocator: Allocator,
    listener: ?std.net.Server = null,
    port: u16 = 0,
    running: bool = false,
    sessions: session_mod.SessionManager,
    db: db_mod.Db,
    static_root: []const u8,

    clients: std.ArrayList(Client) = .empty,
    clients_mutex: std.Thread.Mutex = .{},

    pub fn init(allocator: Allocator, static_root: []const u8, db: db_mod.Db) !Server {
        var server = Server{
            .allocator = allocator,
            .sessions = session_mod.SessionManager.init(allocator),
            .db = db,
            .static_root = static_root,
        };

        const address = std.net.Address.parseIp4("127.0.0.1", 0) catch unreachable;
        server.listener = try address.listen(.{ .reuse_address = true });
        server.port = server.listener.?.listen_address.getPort();
        server.running = true;

        std.log.info("cove server on http://127.0.0.1:{d}", .{server.port});
        return server;
    }

    pub fn deinit(self: *Server) void {
        self.sessions.deinit();

        self.clients_mutex.lock();
        self.clients.deinit(self.allocator);
        self.clients_mutex.unlock();

        if (self.listener) |*l| l.deinit();
    }

    pub fn stop(self: *Server) void {
        self.running = false;
        if (self.listener) |*l| l.deinit();
        self.listener = null;
    }

    pub fn run(self: *Server) void {
        const reader_thread = std.Thread.spawn(.{}, ptyReaderLoop, .{self}) catch return;
        defer reader_thread.join();

        while (self.running) {
            var listener = self.listener orelse break;
            const conn = listener.accept() catch {
                if (!self.running) break;
                continue;
            };
            _ = std.Thread.spawn(.{}, handleConnection, .{ self, conn.stream }) catch {
                conn.stream.close();
            };
        }
    }

    fn handleConnection(self: *Server, stream: std.net.Stream) void {
        var buf: [8192]u8 = undefined;
        const n = stream.read(&buf) catch {
            stream.close();
            return;
        };
        if (n == 0) {
            stream.close();
            return;
        }

        const request = buf[0..n];

        if (extractHeader(request, "Upgrade: ")) |upgrade| {
            if (std.ascii.eqlIgnoreCase(upgrade, "websocket")) {
                self.handleWebSocket(stream, request);
                return;
            }
        }

        self.handleHttpRequest(stream, request);
    }

    fn handleWebSocket(self: *Server, stream: std.net.Stream, request: []const u8) void {
        defer stream.close();

        const ws_key = extractHeader(request, "Sec-WebSocket-Key: ") orelse return;

        const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        var hasher = std.crypto.hash.Sha1.init(.{});
        hasher.update(ws_key);
        hasher.update(magic);
        const digest = hasher.finalResult();

        var accept_buf: [28]u8 = undefined;
        const accept_key = std.base64.standard.Encoder.encode(&accept_buf, &digest);

        var resp_buf: [512]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{accept_key}) catch return;
        _ = stream.write(resp) catch return;

        var client = Client{ .stream = stream, .allocator = self.allocator };
        {
            self.clients_mutex.lock();
            defer self.clients_mutex.unlock();
            self.clients.append(self.allocator, client) catch return;
        }
        defer {
            self.clients_mutex.lock();
            defer self.clients_mutex.unlock();
            for (self.clients.items, 0..) |cl, i| {
                if (cl.stream.handle == stream.handle) {
                    _ = self.clients.swapRemove(i);
                    break;
                }
            }
        }

        while (self.running) {
            const msg = client.readMessage() orelse break;
            defer client.allocator.free(msg);
            self.handleJsonRpc(msg, &client);
        }
    }

    fn handleHttpRequest(self: *Server, stream: std.net.Stream, request: []const u8) void {
        defer stream.close();

        var path: []const u8 = "/";
        if (request.len > 4 and std.mem.startsWith(u8, request, "GET ")) {
            const path_start = 4;
            const path_end = std.mem.indexOfScalar(u8, request[path_start..], ' ') orelse return;
            path = request[path_start .. path_start + path_end];
        }

        if (std.mem.eql(u8, path, "/")) path = "/index.html";

        const rel_path = if (path.len > 0 and path[0] == '/') path[1..] else path;

        if (std.mem.indexOf(u8, rel_path, "..") != null) {
            self.sendHttpError(stream, "403 Forbidden", "Forbidden");
            return;
        }

        const full_path = std.fs.path.join(self.allocator, &.{ self.static_root, rel_path }) catch return;
        defer self.allocator.free(full_path);

        const file = std.fs.cwd().openFile(full_path, .{}) catch {
            self.sendHttpError(stream, "404 Not Found", "Not Found");
            return;
        };
        defer file.close();

        const stat = file.stat() catch return;
        const body = self.allocator.alloc(u8, @intCast(stat.size)) catch return;
        defer self.allocator.free(body);
        const bytes_read = file.readAll(body) catch return;

        const content_type = mimeType(rel_path);

        var header_buf: [512]u8 = undefined;
        const header = std.fmt.bufPrint(&header_buf, "HTTP/1.1 200 OK\r\nContent-Type: {s}\r\nContent-Length: {d}\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n", .{ content_type, bytes_read }) catch return;

        _ = stream.write(header) catch return;
        _ = stream.write(body[0..bytes_read]) catch return;
    }

    fn sendHttpError(_: *Server, stream: std.net.Stream, status: []const u8, body: []const u8) void {
        var buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&buf, "HTTP/1.1 {s}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}", .{ status, body.len, body }) catch return;
        _ = stream.write(resp) catch {};
    }

    // -- JSON-RPC dispatch --

    fn handleJsonRpc(self: *Server, raw: []const u8, client: *Client) void {
        const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, raw, .{}) catch {
            sendError(client, null, -32700, "Parse error");
            return;
        };
        defer parsed.deinit();

        const root = parsed.value.object;
        const method_val = root.get("method") orelse {
            sendError(client, null, -32600, "Invalid Request");
            return;
        };
        const method = method_val.string;
        const id = root.get("id");
        const params = if (root.get("params")) |p| p.object else std.json.ObjectMap.init(self.allocator);

        // PTY methods
        if (std.mem.eql(u8, method, "pty.spawn")) {
            self.rpcPtySpawn(params, id, client);
        } else if (std.mem.eql(u8, method, "pty.write")) {
            self.rpcPtyWrite(params);
        } else if (std.mem.eql(u8, method, "pty.resize")) {
            self.rpcPtyResize(params);
        } else if (std.mem.eql(u8, method, "pty.kill")) {
            self.rpcPtyKill(params);
        }
        // Workspace methods
        else if (std.mem.eql(u8, method, "workspace.list")) {
            self.rpcWorkspaceList(id, client);
        } else if (std.mem.eql(u8, method, "workspace.create")) {
            self.rpcWorkspaceCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "workspace.delete")) {
            self.rpcWorkspaceDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "workspace.setPath")) {
            self.rpcWorkspaceSetPath(params, id, client);
        } else if (std.mem.eql(u8, method, "workspace.getPath")) {
            self.rpcWorkspaceGetPath(params, id, client);
        }
        // Space methods
        else if (std.mem.eql(u8, method, "space.create")) {
            self.rpcSpaceCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "space.delete")) {
            self.rpcSpaceDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "space.list")) {
            self.rpcSpaceList(params, id, client);
        }
        // Node methods
        else if (std.mem.eql(u8, method, "node.create")) {
            self.rpcNodeCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "node.delete")) {
            self.rpcNodeDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "node.list")) {
            self.rpcNodeList(params, id, client);
        } else if (std.mem.eql(u8, method, "node.update")) {
            self.rpcNodeUpdate(params, id, client);
        }
        // Task methods
        else if (std.mem.eql(u8, method, "task.create")) {
            self.rpcTaskCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "task.update")) {
            self.rpcTaskUpdate(params, id, client);
        } else if (std.mem.eql(u8, method, "task.delete")) {
            self.rpcTaskDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "task.list")) {
            self.rpcTaskList(params, id, client);
        } else if (std.mem.eql(u8, method, "task.enqueue")) {
            self.rpcTaskEnqueue(params, id, client);
        } else if (std.mem.eql(u8, method, "task.assign")) {
            self.rpcTaskAssign(params, id, client);
        } else if (std.mem.eql(u8, method, "task.unassign")) {
            self.rpcTaskUnassign(params, id, client);
        }
        // Agent methods
        else if (std.mem.eql(u8, method, "agent.create")) {
            self.rpcAgentCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "agent.update")) {
            self.rpcAgentUpdate(params, id, client);
        } else if (std.mem.eql(u8, method, "agent.delete")) {
            self.rpcAgentDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "agent.list")) {
            self.rpcAgentList(params, id, client);
        }
        // Scheduler methods
        else if (std.mem.eql(u8, method, "scheduler.getSettings")) {
            self.rpcSchedulerGetSettings(params, id, client);
        } else if (std.mem.eql(u8, method, "scheduler.setSettings")) {
            self.rpcSchedulerSetSettings(params, id, client);
        } else if (std.mem.eql(u8, method, "scheduler.initPool")) {
            self.rpcSchedulerInitPool(params, id, client);
        }
        // State hydration
        else if (std.mem.eql(u8, method, "state.hydrate")) {
            self.rpcStateHydrate(id, client);
        }
        // Workspace export/import
        else if (std.mem.eql(u8, method, "workspace.export")) {
            self.rpcWorkspaceExport(params, id, client);
        } else if (std.mem.eql(u8, method, "workspace.import")) {
            self.rpcWorkspaceImport(params, id, client);
        }
        // AI helper
        else if (std.mem.eql(u8, method, "ai.summarize")) {
            self.rpcAiSummarize(params, id, client);
        }
        // Scrollback
        else if (std.mem.eql(u8, method, "scrollback.save")) {
            self.rpcScrollbackSave(params, id, client);
        } else if (std.mem.eql(u8, method, "scrollback.load")) {
            self.rpcScrollbackLoad(params, id, client);
        }
        // Settings
        else if (std.mem.eql(u8, method, "settings.get")) {
            self.rpcSettingsGet(params, id, client);
        } else if (std.mem.eql(u8, method, "settings.set")) {
            self.rpcSettingsSet(params, id, client);
        }
        // Native dialogs
        else if (std.mem.eql(u8, method, "dialog.pickFolder")) {
            self.rpcPickFolder(id, client);
        } else {
            sendError(client, id, -32601, "Method not found");
        }
    }

    // -- PTY RPC handlers --

    fn rpcPtySpawn(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const cwd = getStr(params, "cwd");
        const command = getStr(params, "command");
        const kind_str = getStr(params, "kind") orelse "shell";
        const space_id = getStr(params, "space_id");
        const node_id = getStr(params, "node_id");

        const kind: session_mod.SessionKind = if (std.mem.eql(u8, kind_str, "agent")) .agent else .shell;

        const sess = self.sessions.spawn(kind, cwd, command, space_id, node_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        // Link node to session in DB
        if (node_id) |nid| {
            self.db.updateNodeSession(nid, sess.id) catch {};
        }

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"session_id\":\"{s}\"}}", .{sess.id}) catch return;
        sendResult(client, id, resp);
    }

    fn rpcPtyWrite(self: *Server, params: std.json.ObjectMap) void {
        const session_id = getStr(params, "session_id") orelse return;
        const data = getStr(params, "data") orelse return;
        if (self.sessions.get(session_id)) |s| {
            _ = s.pty_handle.write(data) catch {};
        }
    }

    fn rpcPtyResize(self: *Server, params: std.json.ObjectMap) void {
        const session_id = getStr(params, "session_id") orelse return;
        const cols: u16 = @intCast((params.get("cols") orelse return).integer);
        const rows: u16 = @intCast((params.get("rows") orelse return).integer);
        if (self.sessions.get(session_id)) |s| {
            s.pty_handle.resize(cols, rows) catch {};
        }
    }

    fn rpcPtyKill(self: *Server, params: std.json.ObjectMap) void {
        const session_id = getStr(params, "session_id") orelse return;
        self.sessions.kill(session_id);
    }

    // -- Workspace RPC --

    fn rpcWorkspaceList(self: *Server, id: ?std.json.Value, client: *Client) void {
        const rows = self.db.listWorkspaces(self.allocator) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.name);
                self.allocator.free(row.path);
                if (row.active_space_id) |s| self.allocator.free(s);
            }
            self.allocator.free(rows);
        }

        // Build JSON array
        var buf: [8192]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"name\":\"{s}\",\"path\":\"{s}\"}}", .{ row.id, row.name, row.path }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcWorkspaceCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const name = getStr(params, "name") orelse "Default";
        const path = getStr(params, "path") orelse "";

        const ws_id = std.fmt.allocPrint(self.allocator, "ws-{d}", .{std.time.timestamp()}) catch return;
        defer self.allocator.free(ws_id);

        self.db.createWorkspace(ws_id, name, path) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"id\":\"{s}\"}}", .{ws_id}) catch return;
        sendResult(client, id, resp);
    }

    fn rpcWorkspaceDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const ws_id = getStr(params, "id") orelse return;
        self.db.deleteWorkspace(ws_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcWorkspaceSetPath(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const ws_id = getStr(params, "workspace_id") orelse return;
        const path = getStr(params, "path") orelse return;
        self.db.updateWorkspacePath(ws_id, path) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcWorkspaceGetPath(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const ws_id = getStr(params, "workspace_id") orelse return;
        const path = self.db.getWorkspacePath(self.allocator, ws_id) catch {
            sendResult(client, id, "\"\"");
            return;
        };
        defer self.allocator.free(path);

        var resp_buf: [4096]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "\"{s}\"", .{path}) catch return;
        sendResult(client, id, resp);
    }

    // -- Space RPC --

    fn rpcSpaceCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const workspace_id = getStr(params, "workspace_id") orelse return;
        const name = getStr(params, "name") orelse "Space";
        const dir_path = getStr(params, "directory_path") orelse "";

        const space_id = std.fmt.allocPrint(self.allocator, "sp-{d}", .{std.time.timestamp()}) catch return;
        defer self.allocator.free(space_id);

        self.db.createSpace(space_id, workspace_id, name, dir_path) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"id\":\"{s}\"}}", .{space_id}) catch return;
        sendResult(client, id, resp);
    }

    fn rpcSpaceDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "id") orelse return;
        self.db.deleteSpace(space_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcSpaceList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const workspace_id = getStr(params, "workspace_id") orelse return;
        const rows = self.db.listSpaces(self.allocator, workspace_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.workspace_id);
                self.allocator.free(row.name);
                self.allocator.free(row.directory_path);
                if (row.label_color) |c| self.allocator.free(c);
            }
            self.allocator.free(rows);
        }

        var buf: [8192]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"name\":\"{s}\",\"directory_path\":\"{s}\",\"sort_order\":{d}}}", .{ row.id, row.name, row.directory_path, row.sort_order }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    // -- Node RPC --

    fn rpcNodeCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse return;
        const kind = getStr(params, "kind") orelse "terminal";
        const title = getStr(params, "title") orelse "";

        const nid = std.fmt.allocPrint(self.allocator, "n-{d}", .{std.time.timestamp()}) catch return;
        defer self.allocator.free(nid);

        self.db.createNode(nid, space_id, kind, title) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        // If agent_json provided, store it
        if (getStr(params, "agent_json")) |aj| {
            self.db.updateNodeAgent(nid, aj) catch {};
        }

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"id\":\"{s}\"}}", .{nid}) catch return;
        sendResult(client, id, resp);
    }

    fn rpcNodeDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const nid = getStr(params, "id") orelse return;
        self.db.deleteNode(nid) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcNodeList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse return;
        const rows = self.db.listNodes(self.allocator, space_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.space_id);
                self.allocator.free(row.kind);
                self.allocator.free(row.title);
                if (row.session_id) |s| self.allocator.free(s);
                if (row.agent_json) |a| self.allocator.free(a);
                if (row.task_json) |t| self.allocator.free(t);
            }
            self.allocator.free(rows);
        }

        var buf: [32768]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"kind\":\"{s}\",\"title\":\"{s}\"", .{ row.id, row.space_id, row.kind, row.title }) catch return;
            if (row.task_json) |tj| {
                std.fmt.format(writer, ",\"task_json\":{s}", .{tj}) catch return;
            }
            if (row.agent_json) |aj| {
                std.fmt.format(writer, ",\"agent_json\":{s}", .{aj}) catch return;
            }
            std.fmt.format(writer, ",\"sort_order\":{d}}}", .{row.sort_order}) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcNodeUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const node_id = getStr(params, "id") orelse return;

        // Update task_json if provided
        if (getStr(params, "task_json")) |tj| {
            self.db.updateNodeTask(node_id, tj) catch {};
        }
        // Update agent_json if provided
        if (getStr(params, "agent_json")) |aj| {
            self.db.updateNodeAgent(node_id, aj) catch {};
        }
        // Update title if provided
        if (getStr(params, "title")) |t| {
            self.db.updateNodeTitle(node_id, t) catch {};
        }

        sendResult(client, id, "true");
    }

    // -- Task RPC handlers --

    fn rpcTaskCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const title = getStr(params, "title") orelse "";
        const description = getStr(params, "description") orelse "";
        const priority = getStr(params, "priority") orelse "medium";
        const parent_task_id = getStr(params, "parent_task_id");

        const task_id = std.fmt.allocPrint(self.allocator, "task-{d}", .{std.time.timestamp()}) catch return;
        defer self.allocator.free(task_id);

        self.db.createTask(task_id, space_id, title, description, priority, parent_task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [512]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"title\":\"{s}\",\"status\":\"todo\",\"priority\":\"{s}\",\"queue_status\":\"none\"}}", .{ task_id, space_id, title, priority }) catch return;
        sendResult(client, id, resp);
    }

    fn rpcTaskUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };

        self.db.updateTask(
            task_id,
            getStr(params, "title"),
            getStr(params, "description"),
            getStr(params, "status"),
            getStr(params, "priority"),
            getStr(params, "queue_status"),
        ) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        sendResult(client, id, "true");
    }

    fn rpcTaskDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse return;
        self.db.deleteTask(task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const parent_task_id = getStr(params, "parent_task_id");

        const rows = self.db.listTasks(self.allocator, space_id, parent_task_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.space_id);
                if (row.parent_task_id) |p| self.allocator.free(p);
                self.allocator.free(row.title);
                self.allocator.free(row.description);
                self.allocator.free(row.status);
                self.allocator.free(row.priority);
                self.allocator.free(row.queue_status);
                if (row.assigned_agent_id) |a| self.allocator.free(a);
                if (row.node_id) |n| self.allocator.free(n);
            }
            self.allocator.free(rows);
        }

        var buf: [16384]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"title\":\"{s}\",\"description\":\"{s}\",\"status\":\"{s}\",\"priority\":\"{s}\",\"queue_status\":\"{s}\"", .{ row.id, row.space_id, row.title, row.description, row.status, row.priority, row.queue_status }) catch return;
            if (row.parent_task_id) |p| {
                std.fmt.format(writer, ",\"parent_task_id\":\"{s}\"", .{p}) catch return;
            }
            if (row.assigned_agent_id) |a| {
                std.fmt.format(writer, ",\"assigned_agent_id\":\"{s}\"", .{a}) catch return;
            }
            if (row.queued_at) |q| {
                std.fmt.format(writer, ",\"queued_at\":{d}", .{q}) catch return;
            }
            if (row.dispatched_at) |d| {
                std.fmt.format(writer, ",\"dispatched_at\":{d}", .{d}) catch return;
            }
            if (row.completed_at) |c| {
                std.fmt.format(writer, ",\"completed_at\":{d}", .{c}) catch return;
            }
            std.fmt.format(writer, ",\"sort_order\":{d},\"created_at\":{d}}}", .{ row.sort_order, row.created_at }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcTaskEnqueue(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        self.db.enqueueTask(task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskAssign(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };
        const agent_id = getStr(params, "agent_id") orelse {
            sendError(client, id, -32602, "Missing agent_id");
            return;
        };

        self.db.assignTaskToAgent(task_id, agent_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"task_id\":\"{s}\",\"agent_id\":\"{s}\"}}", .{ task_id, agent_id }) catch return;
        sendResult(client, id, resp);
    }

    fn rpcTaskUnassign(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };

        self.db.unassignTask(task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    // -- Agent RPC handlers --

    fn rpcAgentCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const provider_id = getStr(params, "provider_id") orelse "claude";
        const provider_name = getStr(params, "provider_name") orelse "Claude Code";
        const slot_id = getStr(params, "slot_id");

        const agent_id = slot_id orelse blk: {
            const generated = std.fmt.allocPrint(self.allocator, "agent-{d}", .{std.time.timestamp()}) catch return;
            break :blk generated;
        };
        defer if (slot_id == null) self.allocator.free(agent_id);

        self.db.createAgent(agent_id, space_id, provider_id, provider_name) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"provider_id\":\"{s}\",\"status\":\"idle\"}}", .{ agent_id, space_id, provider_id }) catch return;
        sendResult(client, id, resp);
    }

    fn rpcAgentUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const agent_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };

        self.db.updateAgent(
            agent_id,
            getStr(params, "status"),
            getStr(params, "session_id"),
            getStr(params, "prompt"),
        ) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        sendResult(client, id, "true");
    }

    fn rpcAgentDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const agent_id = getStr(params, "id") orelse return;
        self.db.deleteAgent(agent_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcAgentList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const status_filter = getStr(params, "status");

        const rows = self.db.listAgents(self.allocator, space_id, status_filter) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.space_id);
                self.allocator.free(row.provider_id);
                self.allocator.free(row.provider_name);
                self.allocator.free(row.status);
                if (row.session_id) |s| self.allocator.free(s);
                if (row.assigned_task_id) |t| self.allocator.free(t);
                if (row.prompt) |p| self.allocator.free(p);
                if (row.node_id) |n| self.allocator.free(n);
            }
            self.allocator.free(rows);
        }

        var buf: [16384]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"provider_id\":\"{s}\",\"provider_name\":\"{s}\",\"status\":\"{s}\"", .{ row.id, row.space_id, row.provider_id, row.provider_name, row.status }) catch return;
            if (row.session_id) |s| {
                std.fmt.format(writer, ",\"session_id\":\"{s}\"", .{s}) catch return;
            }
            if (row.assigned_task_id) |t| {
                std.fmt.format(writer, ",\"assigned_task_id\":\"{s}\"", .{t}) catch return;
            }
            if (row.prompt) |p| {
                // Escape quotes in prompt for JSON
                writer.writeAll(",\"prompt\":\"") catch return;
                for (p) |ch| {
                    if (ch == '"') {
                        writer.writeAll("\\\"") catch return;
                    } else if (ch == '\\') {
                        writer.writeAll("\\\\") catch return;
                    } else if (ch == '\n') {
                        writer.writeAll("\\n") catch return;
                    } else {
                        writer.writeByte(ch) catch return;
                    }
                }
                writer.writeByte('"') catch return;
            }
            if (row.started_at) |s| {
                std.fmt.format(writer, ",\"started_at\":{d}", .{s}) catch return;
            }
            std.fmt.format(writer, ",\"sort_order\":{d},\"created_at\":{d}}}", .{ row.sort_order, row.created_at }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    // -- Scheduler RPC handlers --

    fn rpcSchedulerGetSettings(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const workspace_id = getStr(params, "workspace_id") orelse {
            sendError(client, id, -32602, "Missing workspace_id");
            return;
        };

        const settings = self.db.getSchedulerSettings(self.allocator, workspace_id) catch {
            sendResult(client, id, "{\"concurrency\":4,\"auto_dispatch\":true,\"default_agent_id\":\"claude\"}");
            return;
        };

        if (settings) |s| {
            defer {
                self.allocator.free(s.workspace_id);
                self.allocator.free(s.default_agent_id);
            }
            var resp_buf: [256]u8 = undefined;
            const resp = std.fmt.bufPrint(&resp_buf, "{{\"concurrency\":{d},\"auto_dispatch\":{s},\"default_agent_id\":\"{s}\"}}", .{ s.concurrency, if (s.auto_dispatch) "true" else "false", s.default_agent_id }) catch return;
            sendResult(client, id, resp);
        } else {
            sendResult(client, id, "{\"concurrency\":4,\"auto_dispatch\":true,\"default_agent_id\":\"claude\"}");
        }
    }

    fn rpcSchedulerSetSettings(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const workspace_id = getStr(params, "workspace_id") orelse {
            sendError(client, id, -32602, "Missing workspace_id");
            return;
        };

        const concurrency: i32 = if (params.get("concurrency")) |c| @intCast(c.integer) else 4;
        const auto_dispatch = if (params.get("auto_dispatch")) |a| a == .bool and a.bool else true;
        const default_agent_id = getStr(params, "default_agent_id") orelse "claude";

        self.db.setSchedulerSettings(workspace_id, concurrency, auto_dispatch, default_agent_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        sendResult(client, id, "true");
    }

    fn rpcSchedulerInitPool(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const concurrency: i32 = if (params.get("concurrency")) |c| @intCast(c.integer) else 4;
        const provider_id = getStr(params, "provider_id") orelse "claude";
        const provider_name = getStr(params, "provider_name") orelse "Claude Code";

        // Create agent slots
        var i: i32 = 1;
        while (i <= concurrency) : (i += 1) {
            var slot_buf: [32]u8 = undefined;
            const slot_id = std.fmt.bufPrint(&slot_buf, "slot-{d}", .{i}) catch continue;
            self.db.createAgent(slot_id, space_id, provider_id, provider_name) catch {};
        }

        sendResult(client, id, "true");
    }

    fn rpcStateHydrate(self: *Server, id: ?std.json.Value, client: *Client) void {
        // Build complete state JSON with all workspaces, spaces, nodes
        var buf: [65536]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();

        writer.writeAll("{\"workspaces\":[") catch return;

        const workspaces = self.db.listWorkspaces(self.allocator) catch {
            sendResult(client, id, "{\"workspaces\":[],\"settings\":{}}");
            return;
        };
        defer {
            for (workspaces) |ws| {
                self.allocator.free(ws.id);
                self.allocator.free(ws.name);
                self.allocator.free(ws.path);
                if (ws.active_space_id) |s| self.allocator.free(s);
            }
            self.allocator.free(workspaces);
        }

        for (workspaces, 0..) |ws, wi| {
            if (wi > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"name\":\"{s}\",\"path\":\"{s}\",\"spaces\":[", .{ ws.id, ws.name, ws.path }) catch return;

            const spaces = self.db.listSpaces(self.allocator, ws.id) catch continue;
            defer {
                for (spaces) |sp| {
                    self.allocator.free(sp.id);
                    self.allocator.free(sp.workspace_id);
                    self.allocator.free(sp.name);
                    self.allocator.free(sp.directory_path);
                    if (sp.label_color) |c| self.allocator.free(c);
                }
                self.allocator.free(spaces);
            }

            for (spaces, 0..) |sp, si| {
                if (si > 0) writer.writeByte(',') catch return;
                std.fmt.format(writer, "{{\"id\":\"{s}\",\"name\":\"{s}\",\"nodes\":[", .{ sp.id, sp.name }) catch return;

                const nodes = self.db.listNodes(self.allocator, sp.id) catch continue;
                defer {
                    for (nodes) |node| {
                        self.allocator.free(node.id);
                        self.allocator.free(node.space_id);
                        self.allocator.free(node.kind);
                        self.allocator.free(node.title);
                        if (node.session_id) |s| self.allocator.free(s);
                        if (node.agent_json) |a| self.allocator.free(a);
                        if (node.task_json) |t| self.allocator.free(t);
                    }
                    self.allocator.free(nodes);
                }

                for (nodes, 0..) |node, ni| {
                    if (ni > 0) writer.writeByte(',') catch return;
                    std.fmt.format(writer, "{{\"id\":\"{s}\",\"kind\":\"{s}\",\"title\":\"{s}\"", .{ node.id, node.kind, node.title }) catch return;
                    if (node.task_json) |tj| {
                        std.fmt.format(writer, ",\"task_json\":{s}", .{tj}) catch return;
                    }
                    if (node.agent_json) |aj| {
                        std.fmt.format(writer, ",\"agent_json\":{s}", .{aj}) catch return;
                    }
                    writer.writeByte('}') catch return;
                }
                writer.writeAll("],\"tasks\":[") catch return;

                // Include tasks for this space
                const tasks = self.db.listTasks(self.allocator, sp.id, null) catch &[_]db_mod.TaskRow{};
                defer {
                    for (tasks) |task| {
                        self.allocator.free(task.id);
                        self.allocator.free(task.space_id);
                        if (task.parent_task_id) |p| self.allocator.free(p);
                        self.allocator.free(task.title);
                        self.allocator.free(task.description);
                        self.allocator.free(task.status);
                        self.allocator.free(task.priority);
                        self.allocator.free(task.queue_status);
                        if (task.assigned_agent_id) |a| self.allocator.free(a);
                        if (task.node_id) |n| self.allocator.free(n);
                    }
                    self.allocator.free(tasks);
                }

                for (tasks, 0..) |task, ti| {
                    if (ti > 0) writer.writeByte(',') catch return;
                    std.fmt.format(writer, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"title\":\"{s}\",\"description\":\"{s}\",\"status\":\"{s}\",\"priority\":\"{s}\",\"queue_status\":\"{s}\"", .{ task.id, task.space_id, task.title, task.description, task.status, task.priority, task.queue_status }) catch return;
                    if (task.parent_task_id) |p| {
                        std.fmt.format(writer, ",\"parent_task_id\":\"{s}\"", .{p}) catch return;
                    }
                    if (task.assigned_agent_id) |a| {
                        std.fmt.format(writer, ",\"assigned_agent_id\":\"{s}\"", .{a}) catch return;
                    }
                    if (task.queued_at) |q| {
                        std.fmt.format(writer, ",\"queued_at\":{d}", .{q}) catch return;
                    }
                    if (task.dispatched_at) |d| {
                        std.fmt.format(writer, ",\"dispatched_at\":{d}", .{d}) catch return;
                    }
                    if (task.completed_at) |co| {
                        std.fmt.format(writer, ",\"completed_at\":{d}", .{co}) catch return;
                    }
                    std.fmt.format(writer, ",\"created_at\":{d}}}", .{task.created_at}) catch return;
                }
                writer.writeAll("],\"agents\":[") catch return;

                // Include agents for this space
                const agents = self.db.listAgents(self.allocator, sp.id, null) catch &[_]db_mod.AgentRow{};
                defer {
                    for (agents) |agent| {
                        self.allocator.free(agent.id);
                        self.allocator.free(agent.space_id);
                        self.allocator.free(agent.provider_id);
                        self.allocator.free(agent.provider_name);
                        self.allocator.free(agent.status);
                        if (agent.session_id) |s| self.allocator.free(s);
                        if (agent.assigned_task_id) |t| self.allocator.free(t);
                        if (agent.prompt) |p| self.allocator.free(p);
                        if (agent.node_id) |n| self.allocator.free(n);
                    }
                    self.allocator.free(agents);
                }

                for (agents, 0..) |agent, ai| {
                    if (ai > 0) writer.writeByte(',') catch return;
                    std.fmt.format(writer, "{{\"id\":\"{s}\",\"space_id\":\"{s}\",\"provider_id\":\"{s}\",\"provider_name\":\"{s}\",\"status\":\"{s}\"", .{ agent.id, agent.space_id, agent.provider_id, agent.provider_name, agent.status }) catch return;
                    if (agent.session_id) |s| {
                        std.fmt.format(writer, ",\"session_id\":\"{s}\"", .{s}) catch return;
                    }
                    if (agent.assigned_task_id) |t| {
                        std.fmt.format(writer, ",\"assigned_task_id\":\"{s}\"", .{t}) catch return;
                    }
                    if (agent.started_at) |s| {
                        std.fmt.format(writer, ",\"started_at\":{d}", .{s}) catch return;
                    }
                    std.fmt.format(writer, ",\"created_at\":{d}}}", .{agent.created_at}) catch return;
                }
                writer.writeAll("]}") catch return;
            }
            writer.writeAll("]}") catch return;
        }

        writer.writeAll("],\"settings\":{}}") catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcWorkspaceExport(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const workspace_id = getStr(params, "workspace_id") orelse {
            sendError(client, id, -32602, "Missing workspace_id");
            return;
        };

        // Reuse hydration logic but for single workspace
        var buf: [65536]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();

        writer.writeAll("{\"json\":\"{") catch return;

        const spaces = self.db.listSpaces(self.allocator, workspace_id) catch {
            sendError(client, id, -32000, "Failed to list spaces");
            return;
        };
        defer {
            for (spaces) |sp| {
                self.allocator.free(sp.id);
                self.allocator.free(sp.workspace_id);
                self.allocator.free(sp.name);
                self.allocator.free(sp.directory_path);
                if (sp.label_color) |c| self.allocator.free(c);
            }
            self.allocator.free(spaces);
        }

        writer.writeAll("\\\"spaces\\\":[") catch return;
        for (spaces, 0..) |sp, si| {
            if (si > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\\\"id\\\":\\\"{s}\\\",\\\"name\\\":\\\"{s}\\\",\\\"nodes\\\":[", .{ sp.id, sp.name }) catch return;

            const nodes = self.db.listNodes(self.allocator, sp.id) catch continue;
            defer {
                for (nodes) |node| {
                    self.allocator.free(node.id);
                    self.allocator.free(node.space_id);
                    self.allocator.free(node.kind);
                    self.allocator.free(node.title);
                    if (node.session_id) |s| self.allocator.free(s);
                    if (node.agent_json) |a| self.allocator.free(a);
                    if (node.task_json) |t| self.allocator.free(t);
                }
                self.allocator.free(nodes);
            }

            for (nodes, 0..) |node, ni| {
                if (ni > 0) writer.writeByte(',') catch return;
                std.fmt.format(writer, "{{\\\"id\\\":\\\"{s}\\\",\\\"kind\\\":\\\"{s}\\\",\\\"title\\\":\\\"{s}\\\"}}", .{ node.id, node.kind, node.title }) catch return;
            }
            writer.writeAll("]}") catch return;
        }
        writer.writeAll("]}\"}") catch return;

        sendResult(client, id, fbs.getWritten());
    }

    fn rpcWorkspaceImport(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const json_str = getStr(params, "json") orelse {
            sendError(client, id, -32602, "Missing json");
            return;
        };

        // Parse and import workspace data
        const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, json_str, .{}) catch {
            sendError(client, id, -32000, "Invalid JSON");
            return;
        };
        defer parsed.deinit();

        const root = parsed.value.object;
        const spaces_arr = root.get("spaces") orelse {
            sendError(client, id, -32000, "Missing spaces array");
            return;
        };

        // Create new workspace
        const ws_id = std.fmt.allocPrint(self.allocator, "ws-{d}", .{std.time.timestamp()}) catch {
            sendError(client, id, -32000, "Failed to generate workspace id");
            return;
        };
        defer self.allocator.free(ws_id);

        self.db.createWorkspace(ws_id, "Imported", ".") catch {
            sendError(client, id, -32000, "Failed to create workspace");
            return;
        };

        // Import spaces and nodes
        var space_counter: u64 = 0;
        for (spaces_arr.array.items) |space_val| {
            const sp_obj = space_val.object;
            const sp_name = if (sp_obj.get("name")) |n| n.string else "Space";

            const sp_id = std.fmt.allocPrint(self.allocator, "sp-{d}-{d}", .{ std.time.timestamp(), space_counter }) catch continue;
            defer self.allocator.free(sp_id);
            space_counter += 1;

            self.db.createSpace(sp_id, ws_id, sp_name, ".") catch continue;

            if (sp_obj.get("nodes")) |nodes_arr| {
                var node_counter: u64 = 0;
                for (nodes_arr.array.items) |node_val| {
                    const node_obj = node_val.object;
                    const kind = if (node_obj.get("kind")) |k| k.string else "shell";
                    const title = if (node_obj.get("title")) |t| t.string else "Node";

                    const node_id = std.fmt.allocPrint(self.allocator, "node-{d}-{d}", .{ std.time.timestamp(), node_counter }) catch continue;
                    defer self.allocator.free(node_id);
                    node_counter += 1;

                    self.db.createNode(node_id, sp_id, kind, title) catch continue;
                }
            }
        }

        sendResult(client, id, "{\"success\":true}");
    }

    fn rpcAiSummarize(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const user_prompt = getStr(params, "prompt") orelse {
            sendError(client, id, -32602, "Missing prompt");
            return;
        };
        const pane_id = getStr(params, "pane_id") orelse "";

        const AiCtx = struct {
            server: *Server,
            prompt: [2048]u8 = undefined,
            prompt_len: usize,
            pane_id: [256]u8 = undefined,
            pane_id_len: usize,
        };

        const ctx = self.allocator.create(AiCtx) catch {
            sendError(client, id, -32000, "OOM");
            return;
        };
        const copy_len = @min(user_prompt.len, ctx.prompt.len);
        @memcpy(ctx.prompt[0..copy_len], user_prompt[0..copy_len]);
        ctx.prompt_len = copy_len;
        const pid_len = @min(pane_id.len, ctx.pane_id.len);
        @memcpy(ctx.pane_id[0..pid_len], pane_id[0..pid_len]);
        ctx.pane_id_len = pid_len;
        ctx.server = self;

        const thread = std.Thread.spawn(.{}, struct {
            fn run(c: *AiCtx) void {
                defer c.server.allocator.destroy(c);
                const prompt_slice = c.prompt[0..c.prompt_len];
                const pane_id_slice = c.pane_id[0..c.pane_id_len];

                // Build summarization prompt
                var full_buf: [2048]u8 = undefined;
                const full_prompt = std.fmt.bufPrint(&full_buf,
                    "Write a concise 1-sentence description for a task titled: \"{s}\". Reply with only the description text.",
                    .{prompt_slice}
                ) catch prompt_slice;

                // Run claude -p (non-interactive) with haiku model
                const result = std.process.Child.run(.{
                    .allocator = c.server.allocator,
                    .argv = &[_][]const u8{
                        "claude", "-p", full_prompt,
                        "--model", "claude-haiku-4-5-20251001",
                    },
                }) catch {
                    c.server.broadcastAiResult(pane_id_slice, prompt_slice);
                    return;
                };
                defer {
                    c.server.allocator.free(result.stdout);
                    c.server.allocator.free(result.stderr);
                }

                const raw = std.mem.trim(u8, result.stdout, " \t\r\n");
                const desc = if (raw.len > 0) raw else prompt_slice;

                // Escape for JSON
                var escaped: std.ArrayList(u8) = .empty;
                defer escaped.deinit(c.server.allocator);
                for (desc) |ch| {
                    if (ch == '"' or ch == '\\') escaped.append(c.server.allocator, '\\') catch continue;
                    if (ch == '\n') {
                        escaped.appendSlice(c.server.allocator, "\\n") catch continue;
                    } else if (ch >= 32) {
                        escaped.append(c.server.allocator, ch) catch continue;
                    }
                }
                c.server.broadcastAiResult(pane_id_slice, escaped.items);
            }
        }.run, .{ctx}) catch {
            self.allocator.destroy(ctx);
            sendError(client, id, -32000, "Thread spawn failed");
            return;
        };
        thread.detach();

        // Return immediately — result comes back via ai.result broadcast
        sendResult(client, id, "{\"status\":\"pending\"}");
    }

    fn broadcastAiResult(self: *Server, pane_id: []const u8, description: []const u8) void {
        var buf: [4096]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf,
            "{{\"jsonrpc\":\"2.0\",\"method\":\"ai.result\",\"params\":{{\"pane_id\":\"{s}\",\"description\":\"{s}\"}}}}",
            .{ pane_id, description }
        ) catch return;
        self.broadcastToClients(msg);
    }

    // -- Native Dialog RPC --

    fn rpcPickFolder(self: *Server, id: ?std.json.Value, client: *Client) void {
        if (macos.showFolderPicker(self.allocator)) |path| {
            defer self.allocator.free(path);
            var buf: [4096]u8 = undefined;
            const resp = std.fmt.bufPrint(&buf, "\"{s}\"", .{path}) catch {
                sendResult(client, id, "null");
                return;
            };
            sendResult(client, id, resp);
        } else {
            sendResult(client, id, "null");
        }
    }

    // -- Scrollback RPC --

    fn rpcScrollbackSave(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const node_id = getStr(params, "node_id") orelse return;
        const data = getStr(params, "data") orelse return;
        self.db.saveScrollback(node_id, data) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcScrollbackLoad(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const node_id = getStr(params, "node_id") orelse return;
        const data = self.db.loadScrollback(self.allocator, node_id) catch null;
        if (data) |d| {
            defer self.allocator.free(d);
            // Base64 encode for safe transport
            const b64_len = std.base64.standard.Encoder.calcSize(d.len);
            const b64_buf = self.allocator.alloc(u8, b64_len) catch return;
            defer self.allocator.free(b64_buf);
            _ = std.base64.standard.Encoder.encode(b64_buf, d);

            // Build JSON with base64 data
            const json = std.fmt.allocPrint(self.allocator, "{{\"data\":\"{s}\"}}", .{b64_buf}) catch return;
            defer self.allocator.free(json);
            sendResult(client, id, json);
        } else {
            sendResult(client, id, "null");
        }
    }

    // -- Settings RPC --

    fn rpcSettingsGet(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const key = getStr(params, "key") orelse return;
        const val = self.db.getSetting(self.allocator, key) catch null;
        if (val) |v| {
            defer self.allocator.free(v);
            sendResult(client, id, v);
        } else {
            sendResult(client, id, "null");
        }
    }

    fn rpcSettingsSet(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const key = getStr(params, "key") orelse return;
        const value = getStr(params, "value") orelse return;
        self.db.setSetting(key, value) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    // -- PTY reader loop --

    fn ptyReaderLoop(self: *Server) void {
        var buf: [16384]u8 = undefined;
        while (self.running) {
            var has_data = false;
            var it = self.sessions.iterator();
            while (it.next()) |entry| {
                const sess = entry.value_ptr;
                if (sess.status != .running) continue;
                const bytes = sess.pty_handle.read(&buf) catch |err| {
                    if (err == error.WouldBlock) continue;
                    sess.status = .exited;
                    self.broadcastPtyExit(entry.key_ptr.*);

                    // Send notification on agent exit
                    if (sess.kind == .agent) {
                        const title = if (sess.exit_code) |code| (if (code == 0) "Task Completed" else "Task Failed") else "Agent Exited";
                        const body = if (sess.exit_code) |code| (if (code == 0) "Agent finished successfully" else "Agent exited with error") else "Session ended";
                        notify.sendNotification(self.allocator, title, body) catch {};
                        self.broadcastNotification(title, body);
                    }
                    continue;
                };
                if (bytes > 0) {
                    has_data = true;
                    self.broadcastPtyData(entry.key_ptr.*, buf[0..bytes]);

                    // Check for standby patterns in agent output
                    if (sess.kind == .agent and notify.containsStandbyPattern(buf[0..bytes])) {
                        notify.sendNotification(self.allocator, "Agent Needs Attention", "Session waiting for input") catch {};
                        self.broadcastNotification("Agent Standby", "Session waiting for input");
                    }
                }
            }
            if (!has_data) std.Thread.sleep(5 * std.time.ns_per_ms);
        }
    }

    fn broadcastPtyData(self: *Server, session_id: []const u8, data: []const u8) void {
        const b64_len = std.base64.standard.Encoder.calcSize(data.len);
        const b64_buf = self.allocator.alloc(u8, b64_len) catch return;
        defer self.allocator.free(b64_buf);
        _ = std.base64.standard.Encoder.encode(b64_buf, data);

        var msg_buf: [32768]u8 = undefined;
        const msg = std.fmt.bufPrint(&msg_buf, "{{\"jsonrpc\":\"2.0\",\"method\":\"pty.data\",\"params\":{{\"session_id\":\"{s}\",\"data\":\"{s}\"}}}}", .{ session_id, b64_buf }) catch return;
        self.broadcastToClients(msg);
    }

    fn broadcastPtyExit(self: *Server, session_id: []const u8) void {
        var msg_buf: [512]u8 = undefined;
        const msg = std.fmt.bufPrint(&msg_buf, "{{\"jsonrpc\":\"2.0\",\"method\":\"pty.exit\",\"params\":{{\"session_id\":\"{s}\"}}}}", .{session_id}) catch return;
        self.broadcastToClients(msg);
    }

    fn broadcastNotification(self: *Server, title: []const u8, body: []const u8) void {
        var msg_buf: [1024]u8 = undefined;
        const msg = std.fmt.bufPrint(&msg_buf, "{{\"jsonrpc\":\"2.0\",\"method\":\"notification\",\"params\":{{\"title\":\"{s}\",\"body\":\"{s}\"}}}}", .{ title, body }) catch return;
        self.broadcastToClients(msg);
    }

    fn broadcastToClients(self: *Server, msg: []const u8) void {
        self.clients_mutex.lock();
        defer self.clients_mutex.unlock();
        for (self.clients.items) |*client| {
            client.sendMessage(msg);
        }
    }
};

// -- Client (WebSocket connection) --

const Client = struct {
    stream: std.net.Stream,
    allocator: std.mem.Allocator = std.heap.page_allocator,

    fn streamReadAll(stream: std.net.Stream, buf: []u8) !void {
        var total: usize = 0;
        while (total < buf.len) {
            const bytes = stream.read(buf[total..]) catch |err| return err;
            if (bytes == 0) return error.EndOfStream;
            total += bytes;
        }
    }

    fn readMessage(self: *Client) ?[]u8 {
        var header: [2]u8 = undefined;
        streamReadAll(self.stream, &header) catch return null;

        const masked = (header[1] & 0x80) != 0;
        var payload_len: u64 = header[1] & 0x7F;

        if (payload_len == 126) {
            var ext: [2]u8 = undefined;
            streamReadAll(self.stream, &ext) catch return null;
            payload_len = std.mem.readInt(u16, &ext, .big);
        } else if (payload_len == 127) {
            var ext: [8]u8 = undefined;
            streamReadAll(self.stream, &ext) catch return null;
            payload_len = std.mem.readInt(u64, &ext, .big);
        }

        var mask: [4]u8 = .{ 0, 0, 0, 0 };
        if (masked) streamReadAll(self.stream, &mask) catch return null;
        if (payload_len > 1_000_000) return null;

        const payload = self.allocator.alloc(u8, @intCast(payload_len)) catch return null;
        streamReadAll(self.stream, payload) catch {
            self.allocator.free(payload);
            return null;
        };

        if (masked) {
            for (payload, 0..) |*byte, i| byte.* ^= mask[i % 4];
        }
        if ((header[0] & 0x0F) == 0x08) {
            self.allocator.free(payload);
            return null;
        }
        return payload;
    }

    fn sendMessage(self: *Client, msg: []const u8) void {
        var frame_header: [10]u8 = undefined;
        var header_len: usize = 2;
        frame_header[0] = 0x81;
        if (msg.len < 126) {
            frame_header[1] = @intCast(msg.len);
        } else if (msg.len < 65536) {
            frame_header[1] = 126;
            std.mem.writeInt(u16, frame_header[2..4], @intCast(msg.len), .big);
            header_len = 4;
        } else {
            frame_header[1] = 127;
            std.mem.writeInt(u64, frame_header[2..10], @intCast(msg.len), .big);
            header_len = 10;
        }
        _ = self.stream.write(frame_header[0..header_len]) catch return;
        _ = self.stream.write(msg) catch return;
    }
};

// -- Helpers --

fn getStr(params: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const val = params.get(key) orelse return null;
    return switch (val) {
        .string => |s| s,
        else => null,
    };
}

fn extractHeader(request: []const u8, name: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i < request.len) {
        if (std.mem.startsWith(u8, request[i..], name)) {
            const start = i + name.len;
            const end = std.mem.indexOfScalar(u8, request[start..], '\r') orelse (request.len - start);
            return request[start .. start + end];
        }
        if (std.mem.indexOfScalar(u8, request[i..], '\n')) |nl| {
            i += nl + 1;
        } else break;
    }
    return null;
}

fn mimeType(path: []const u8) []const u8 {
    if (std.mem.endsWith(u8, path, ".html")) return "text/html; charset=utf-8";
    if (std.mem.endsWith(u8, path, ".css")) return "text/css; charset=utf-8";
    if (std.mem.endsWith(u8, path, ".js")) return "application/javascript; charset=utf-8";
    if (std.mem.endsWith(u8, path, ".json")) return "application/json";
    if (std.mem.endsWith(u8, path, ".svg")) return "image/svg+xml";
    if (std.mem.endsWith(u8, path, ".woff2")) return "font/woff2";
    if (std.mem.endsWith(u8, path, ".woff")) return "font/woff";
    if (std.mem.endsWith(u8, path, ".png")) return "image/png";
    return "application/octet-stream";
}

fn sendResult(client: *Client, id: ?std.json.Value, result: []const u8) void {
    var buf: [32768]u8 = undefined;
    var id_buf: [32]u8 = undefined;
    const id_str = formatId(id, &id_buf);
    const msg = std.fmt.bufPrint(&buf, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}", .{ id_str, result }) catch return;
    client.sendMessage(msg);
}

fn sendError(client: *Client, id: ?std.json.Value, code: i32, message: []const u8) void {
    var buf: [512]u8 = undefined;
    var id_buf: [32]u8 = undefined;
    const id_str = formatId(id, &id_buf);
    const msg = std.fmt.bufPrint(&buf, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":{d},\"message\":\"{s}\"}}}}", .{ id_str, code, message }) catch return;
    client.sendMessage(msg);
}

fn formatId(id: ?std.json.Value, buf: *[32]u8) []const u8 {
    if (id) |v| {
        return switch (v) {
            .integer => |n_val| std.fmt.bufPrint(buf, "{d}", .{n_val}) catch "null",
            else => "null",
        };
    }
    return "null";
}
