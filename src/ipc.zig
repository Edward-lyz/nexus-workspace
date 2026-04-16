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
    scheduler_mutex: std.Thread.Mutex = .{},

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

        std.log.info("nexus server on http://127.0.0.1:{d}", .{server.port});
        return server;
    }

    pub fn deinit(self: *Server) void {
        self.sessions.deinit();
        self.db.close();

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
            self.rpcPtyWrite(params, id, client);
        } else if (std.mem.eql(u8, method, "pty.resize")) {
            self.rpcPtyResize(params, id, client);
        } else if (std.mem.eql(u8, method, "pty.kill")) {
            self.rpcPtyKill(params, id, client);
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
        } else if (std.mem.eql(u8, method, "space.rename")) {
            self.rpcSpaceRename(params, id, client);
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
        } else if (std.mem.eql(u8, method, "task.resetDispatch")) {
            self.rpcTaskResetDispatch(params, id, client);
        } else if (std.mem.eql(u8, method, "taskRun.list")) {
            self.rpcTaskRunList(params, id, client);
        }
        // Comment methods
        else if (std.mem.eql(u8, method, "comment.create")) {
            self.rpcCommentCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "comment.list")) {
            self.rpcCommentList(params, id, client);
        } else if (std.mem.eql(u8, method, "comment.update")) {
            self.rpcCommentUpdate(params, id, client);
        } else if (std.mem.eql(u8, method, "comment.delete")) {
            self.rpcCommentDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "task.block")) {
            self.rpcTaskBlock(params, id, client);
        } else if (std.mem.eql(u8, method, "task.cancel")) {
            self.rpcTaskCancel(params, id, client);
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
        } else if (std.mem.eql(u8, method, "scheduler.dispatch")) {
            self.rpcSchedulerDispatch(params, id, client);
        } else if (std.mem.eql(u8, method, "scheduler.handleSessionExit")) {
            self.rpcSchedulerHandleSessionExit(params, id, client);
        } else if (std.mem.eql(u8, method, "scheduler.stopTask")) {
            self.rpcSchedulerStopTask(params, id, client);
        } else if (std.mem.eql(u8, method, "scheduler.attachTaskSession")) {
            self.rpcSchedulerAttachTaskSession(params, id, client);
        } else if (std.mem.eql(u8, method, "scheduler.reconcileSpace")) {
            self.rpcSchedulerReconcileSpace(params, id, client);
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
        } else if (std.mem.eql(u8, method, "workspace.exportDb")) {
            self.rpcWorkspaceExportDb(id, client);
        } else if (std.mem.eql(u8, method, "workspace.importDb")) {
            self.rpcWorkspaceImportDb(params, id, client);
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
        } else if (std.mem.eql(u8, method, "taskLiveOutput.save")) {
            self.rpcTaskLiveOutputSave(params, id, client);
        } else if (std.mem.eql(u8, method, "taskLiveOutput.load")) {
            self.rpcTaskLiveOutputLoad(params, id, client);
        }
        // Settings
        else if (std.mem.eql(u8, method, "settings.get")) {
            self.rpcSettingsGet(params, id, client);
        } else if (std.mem.eql(u8, method, "settings.set")) {
            self.rpcSettingsSet(params, id, client);
        }
        // App metadata
        else if (std.mem.eql(u8, method, "app.version")) {
            sendResult(client, id, "\"0.2.0\"");
        }
        // Native dialogs
        else if (std.mem.eql(u8, method, "dialog.pickFolder")) {
            self.rpcPickFolder(id, client);
        }
        // Project methods
        else if (std.mem.eql(u8, method, "project.create")) {
            self.rpcProjectCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "project.list")) {
            self.rpcProjectList(params, id, client);
        } else if (std.mem.eql(u8, method, "project.update")) {
            self.rpcProjectUpdate(params, id, client);
        } else if (std.mem.eql(u8, method, "project.delete")) {
            self.rpcProjectDelete(params, id, client);
        }
        // Inbox methods
        else if (std.mem.eql(u8, method, "inbox.list")) {
            self.rpcInboxList(params, id, client);
        } else if (std.mem.eql(u8, method, "inbox.markRead")) {
            self.rpcInboxMarkRead(params, id, client);
        } else if (std.mem.eql(u8, method, "inbox.markAllRead")) {
            self.rpcInboxMarkAllRead(params, id, client);
        }
        // Autopilot methods
        else if (std.mem.eql(u8, method, "autopilot.create")) {
            self.rpcAutopilotCreate(params, id, client);
        } else if (std.mem.eql(u8, method, "autopilot.list")) {
            self.rpcAutopilotList(params, id, client);
        } else if (std.mem.eql(u8, method, "autopilot.update")) {
            self.rpcAutopilotUpdate(params, id, client);
        } else if (std.mem.eql(u8, method, "autopilot.delete")) {
            self.rpcAutopilotDelete(params, id, client);
        } else if (std.mem.eql(u8, method, "autopilot.setEnabled")) {
            self.rpcAutopilotSetEnabled(params, id, client);
        } else {
            sendError(client, id, -32601, "Method not found");
        }
    }

    // -- PTY RPC handlers --

    fn rpcPtySpawn(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        var resolved_cwd: ?[]u8 = null;
        defer if (resolved_cwd) |cwd| self.allocator.free(cwd);

        const requested_cwd = getStr(params, "cwd");
        const command = getStr(params, "command");
        const kind_str = getStr(params, "kind") orelse "shell";
        const space_id = getStr(params, "space_id");
        const node_id = getStr(params, "node_id");

        const kind: session_mod.SessionKind = if (std.mem.eql(u8, kind_str, "agent")) .agent else .shell;
        const cwd = blk: {
            if (requested_cwd) |cwd| break :blk cwd;
            if (space_id) |sid| {
                const directory_path = self.db.getSpaceDirectoryPath(self.allocator, sid) catch null;
                if (directory_path) |path| {
                    if (path.len == 0) {
                        self.allocator.free(path);
                        break :blk null;
                    }
                    resolved_cwd = path;
                    break :blk path;
                }
            }
            break :blk null;
        };

        const sess = self.sessions.spawn(kind, cwd, command, space_id, node_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        // Link node to session in DB
        if (node_id) |nid| {
            if (space_id) |sid| {
                self.db.ensureNode(nid, sid, "terminal", "Terminal") catch {};
            }
            self.db.updateNodeSession(nid, sess.id) catch {};
        }

        var resp_buf: [256]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"session_id\":\"{s}\"}}", .{sess.id}) catch return;
        sendResult(client, id, resp);
    }

    fn rpcPtyWrite(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const session_id = getStr(params, "session_id") orelse return;
        const data = getStr(params, "data") orelse return;
        if (self.sessions.get(session_id)) |s| {
            _ = s.pty_handle.write(data) catch {};
        }
        if (id != null) sendResult(client, id, "true");
    }

    fn rpcPtyResize(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const session_id = getStr(params, "session_id") orelse return;
        const cols: u16 = @intCast((params.get("cols") orelse return).integer);
        const rows: u16 = @intCast((params.get("rows") orelse return).integer);
        if (self.sessions.get(session_id)) |s| {
            s.pty_handle.resize(cols, rows) catch {};
        }
        if (id != null) sendResult(client, id, "true");
    }

    fn rpcPtyKill(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const session_id = getStr(params, "session_id") orelse return;
        const killed_agent_session = if (self.sessions.get(session_id)) |session| session.kind == .agent else false;
        self.sessions.kill(session_id);
        self.broadcastPtyExit(session_id);

        if (killed_agent_session) {
            self.db.finishTaskRun(session_id, "cancelled") catch {};
            self.reconcileAgentSessionExit(session_id);
            notify.sendNotification(self.allocator, "Agent Exited", "Session ended") catch {};
            self.broadcastNotification("Agent Exited", "Session ended");
        }

        if (id != null) sendResult(client, id, "true");
    }

    fn agentCommandForProvider(provider_id: []const u8) ![]const u8 {
        if (std.mem.eql(u8, provider_id, "claude")) return "claude";
        if (std.mem.eql(u8, provider_id, "codex")) return "codex";
        return error.UnsupportedAgentProvider;
    }

    fn buildAgentKickoffPrompt(self: *Server, context: db_mod.AgentLaunchContext) ![]u8 {
        const task_identifier = context.task_identifier orelse context.task_id;
        const task_description = if (context.task_description.len > 0) context.task_description else "No description provided.";
        const workspace_path = if (context.space_directory_path.len > 0) context.space_directory_path else "(workspace directory not set)";
        const agent_prompt = context.agent_prompt orelse "Keep progress visible and report blockers immediately.";

        return std.fmt.allocPrint(
            self.allocator,
            "Agent instructions:\n{s}\n\nAssigned task {s}: {s}\nPriority: {s}\nWorkspace: {s}\n\nTask description:\n{s}\n\nStart working immediately. Keep terminal output informative so the developer can intervene when needed.\n",
            .{
                agent_prompt,
                task_identifier,
                context.task_title,
                context.task_priority,
                workspace_path,
                task_description,
            },
        );
    }

    fn startAssignedAgentSession(self: *Server, task_id: []const u8) ![]const u8 {
        const context = (try self.db.getAgentLaunchContext(self.allocator, task_id)) orelse return error.TaskNotAssigned;
        defer db_mod.freeAgentLaunchContext(self.allocator, context);

        const command = try agentCommandForProvider(context.provider_id);
        const cwd = if (context.space_directory_path.len > 0) context.space_directory_path else null;
        const kickoff_prompt = try self.buildAgentKickoffPrompt(context);
        defer self.allocator.free(kickoff_prompt);

        const session = try self.sessions.spawn(.agent, cwd, command, null, null);
        errdefer self.sessions.kill(session.id);

        try self.db.updateAgent(context.agent_id, "running", session.id, null, false, false);
        try self.db.startTaskRun(task_id, context.agent_id, context.provider_id, context.provider_name, session.id);

        _ = session.pty_handle.write(kickoff_prompt) catch {};
        _ = session.pty_handle.write("\n") catch {};

        return session.id;
    }

    fn stopTaskExecution(self: *Server, task_id: []const u8, run_status: []const u8) void {
        const binding = self.db.getTaskExecutionBinding(self.allocator, task_id) catch return orelse return;
        defer db_mod.freeTaskExecutionBinding(self.allocator, binding);

        if (binding.session_id) |session_id| {
            self.sessions.kill(session_id);
            self.broadcastPtyExit(session_id);
            self.db.finishTaskRun(session_id, run_status) catch {};
        }
    }

    fn reconcileAgentSessionExit(self: *Server, session_id: []const u8) void {
        self.scheduler_mutex.lock();
        defer self.scheduler_mutex.unlock();

        const binding = self.db.getSessionAgentBinding(self.allocator, session_id) catch return orelse return;
        defer db_mod.freeSessionAgentBinding(self.allocator, binding);

        self.db.finishTaskRun(session_id, "completed") catch {};

        if (binding.assigned_task_id) |task_id| {
            const task_title = self.db.getTaskTitle(self.allocator, task_id) catch null;
            defer if (task_title) |t| self.allocator.free(t);

            const inbox_id = std.fmt.allocPrint(self.allocator, "inbox-{d}", .{std.time.nanoTimestamp()}) catch null;
            if (inbox_id) |iid| {
                defer self.allocator.free(iid);
                const title = task_title orelse "Task";
                const msg = std.fmt.allocPrint(self.allocator, "Agent completed: {s}", .{title}) catch null;
                if (msg) |m| {
                    defer self.allocator.free(m);
                    self.db.createInboxItem(iid, binding.space_id, "task_completed", task_id, m) catch {};
                }
            }

            self.db.unassignTask(task_id) catch {};
            return;
        }

        self.db.updateAgent(binding.agent_id, "idle", null, null, true, true) catch {};
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
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"name\":") catch return;
            writeJsonString(writer, row.name) catch return;
            writer.writeAll(",\"path\":") catch return;
            writeJsonString(writer, row.path) catch return;
            writer.writeByte('}') catch return;
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

        // Leave enough room for escaped task titles/descriptions in the RPC response payload.
        var resp_buf: [4096]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "\"{s}\"", .{path}) catch return;
        sendResult(client, id, resp);
    }

    // -- Space RPC --

    fn rpcSpaceCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const workspace_id = getStr(params, "workspace_id") orelse return;
        const name = getStr(params, "name") orelse "Space";
        const dir_path = getStr(params, "directory_path") orelse "";
        const requested_id = getStr(params, "id");

        const space_id = requested_id orelse blk: {
            const generated = std.fmt.allocPrint(self.allocator, "sp-{d}", .{std.time.timestamp()}) catch return;
            break :blk generated;
        };
        defer if (requested_id == null) self.allocator.free(space_id);

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

    fn rpcSpaceRename(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "id") orelse return;
        const name = getStr(params, "name") orelse return;
        self.db.renameSpace(space_id, name) catch |err| {
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
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"name\":") catch return;
            writeJsonString(writer, row.name) catch return;
            writer.writeAll(",\"directory_path\":") catch return;
            writeJsonString(writer, row.directory_path) catch return;
            std.fmt.format(writer, ",\"sort_order\":{d}}}", .{row.sort_order}) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    // -- Node RPC --

    fn rpcNodeCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse return;
        const kind = getStr(params, "kind") orelse "terminal";
        const title = getStr(params, "title") orelse "";
        const provided_id = getStr(params, "id");

        const nid = provided_id orelse blk: {
            const generated = std.fmt.allocPrint(self.allocator, "n-{d}", .{std.time.timestamp()}) catch return;
            break :blk generated;
        };
        defer if (provided_id == null) self.allocator.free(nid);

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
        if (!std.mem.eql(u8, priority, "urgent") and
            !std.mem.eql(u8, priority, "high") and
            !std.mem.eql(u8, priority, "medium") and
            !std.mem.eql(u8, priority, "low") and
            !std.mem.eql(u8, priority, "none"))
        {
            sendError(client, id, -32602, "Invalid priority: must be urgent, high, medium, low, or none");
            return;
        }
        const parent_task_id = getStr(params, "parent_task_id");
        const requested_id = getStr(params, "id");

        const task_id = requested_id orelse blk: {
            // Use nanosecond timestamp to avoid ID collisions within the same second
            const generated = std.fmt.allocPrint(self.allocator, "task-{d}", .{std.time.nanoTimestamp()}) catch return;
            break :blk generated;
        };
        defer if (requested_id == null) self.allocator.free(task_id);

        self.db.createTask(task_id, space_id, title, description, priority, parent_task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [4096]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&resp_buf);
        const writer = fbs.writer();
        writer.writeByte('{') catch return;
        writer.writeAll("\"id\":") catch return;
        writeJsonString(writer, task_id) catch return;
        writer.writeAll(",\"space_id\":") catch return;
        writeJsonString(writer, space_id) catch return;
        writer.writeAll(",\"title\":") catch return;
        writeJsonString(writer, title) catch return;
        writer.writeAll(",\"description\":") catch return;
        writeJsonString(writer, description) catch return;
        writer.writeAll(",\"status\":\"backlog\",\"priority\":") catch return;
        writeJsonString(writer, priority) catch return;
        writer.writeAll(",\"queue_status\":\"none\"") catch return;
        if (parent_task_id) |parent| {
            writer.writeAll(",\"parent_task_id\":") catch return;
            writeJsonString(writer, parent) catch return;
        }
        writer.writeByte('}') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcTaskUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };

        const status_value = getStr(params, "status");
        if (status_value) |s| {
            if (!std.mem.eql(u8, s, "backlog") and
                !std.mem.eql(u8, s, "todo") and
                !std.mem.eql(u8, s, "in_progress") and
                !std.mem.eql(u8, s, "in_review") and
                !std.mem.eql(u8, s, "done") and
                !std.mem.eql(u8, s, "blocked") and
                !std.mem.eql(u8, s, "cancelled"))
            {
                sendError(client, id, -32602, "Invalid status: must be backlog, todo, in_progress, in_review, done, blocked, or cancelled");
                return;
            }
        }

        const priority_value = getStr(params, "priority");
        if (priority_value) |p| {
            if (!std.mem.eql(u8, p, "urgent") and
                !std.mem.eql(u8, p, "high") and
                !std.mem.eql(u8, p, "medium") and
                !std.mem.eql(u8, p, "low") and
                !std.mem.eql(u8, p, "none"))
            {
                sendError(client, id, -32602, "Invalid priority: must be urgent, high, medium, low, or none");
                return;
            }
        }

        self.db.updateTask(
            task_id,
            getStr(params, "title"),
            getStr(params, "description"),
            status_value,
            priority_value,
            getStr(params, "queue_status"),
            getStr(params, "identifier"),
            getStr(params, "due_date"),
            getStr(params, "labels"),
            if (params.get("estimate")) |v| if (v == .integer) @as(?i32, @intCast(v.integer)) else null else null,
            getStr(params, "project_id"),
            getStr(params, "completed_by_agent_id"),
        ) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        sendResult(client, id, "true");
    }

    fn rpcTaskDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse return;
        self.stopTaskExecution(task_id, "cancelled");
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
                if (row.identifier) |v| self.allocator.free(v);
                if (row.due_date) |v| self.allocator.free(v);
                if (row.labels) |v| self.allocator.free(v);
                if (row.completed_by_agent_id) |v| self.allocator.free(v);
                if (row.project_id) |v| self.allocator.free(v);
            }
            self.allocator.free(rows);
        }

        var buf: [32768]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"space_id\":") catch return;
            writeJsonString(writer, row.space_id) catch return;
            writer.writeAll(",\"title\":") catch return;
            writeJsonString(writer, row.title) catch return;
            writer.writeAll(",\"description\":") catch return;
            writeJsonString(writer, row.description) catch return;
            writer.writeAll(",\"status\":") catch return;
            writeJsonString(writer, row.status) catch return;
            writer.writeAll(",\"priority\":") catch return;
            writeJsonString(writer, row.priority) catch return;
            writer.writeAll(",\"queue_status\":") catch return;
            writeJsonString(writer, row.queue_status) catch return;
            if (row.parent_task_id) |p| {
                writer.writeAll(",\"parent_task_id\":") catch return;
                writeJsonString(writer, p) catch return;
            }
            if (row.assigned_agent_id) |a| {
                writer.writeAll(",\"assigned_agent_id\":") catch return;
                writeJsonString(writer, a) catch return;
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
            if (row.identifier) |v| {
                writer.writeAll(",\"identifier\":") catch return;
                writeJsonString(writer, v) catch return;
            }
            if (row.due_date) |v| {
                writer.writeAll(",\"due_date\":") catch return;
                writeJsonString(writer, v) catch return;
            }
            if (row.labels) |v| {
                writer.writeAll(",\"labels\":") catch return;
                writer.writeAll(v) catch return;
            }
            if (row.estimate) |v| {
                std.fmt.format(writer, ",\"estimate\":{d}", .{v}) catch return;
            }
            if (row.completed_by_agent_id) |v| {
                writer.writeAll(",\"completed_by_agent_id\":") catch return;
                writeJsonString(writer, v) catch return;
            }
            if (row.project_id) |v| {
                writer.writeAll(",\"project_id\":") catch return;
                writeJsonString(writer, v) catch return;
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

        self.stopTaskExecution(task_id, "cancelled");
        self.db.assignTaskToAgent(task_id, agent_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        const session_id = self.startAssignedAgentSession(task_id) catch |err| {
            self.db.unassignTask(task_id) catch {};
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [384]u8 = undefined;
        const resp = std.fmt.bufPrint(&resp_buf, "{{\"task_id\":\"{s}\",\"agent_id\":\"{s}\",\"session_id\":\"{s}\"}}", .{ task_id, agent_id, session_id }) catch return;
        sendResult(client, id, resp);
    }

    fn rpcTaskUnassign(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };

        self.stopTaskExecution(task_id, "cancelled");
        self.db.unassignTask(task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskResetDispatch(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        const requeue = if (params.get("requeue")) |value| value == .bool and value.bool else true;

        self.stopTaskExecution(task_id, "cancelled");
        self.db.resetTaskDispatch(task_id, requeue) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskRunList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };

        const rows = self.db.listTaskRuns(self.allocator, task_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer db_mod.freeTaskRunRows(self.allocator, rows);

        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(self.allocator);
        const writer = buf.writer(self.allocator);

        writer.writeByte('[') catch return;
        for (rows, 0..) |row, index| {
            if (index > 0) writer.writeByte(',') catch return;
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"task_id\":") catch return;
            writeJsonString(writer, row.task_id) catch return;
            if (row.agent_id) |agent_id| {
                writer.writeAll(",\"agent_id\":") catch return;
                writeJsonString(writer, agent_id) catch return;
            }
            writer.writeAll(",\"provider_id\":") catch return;
            writeJsonString(writer, row.provider_id) catch return;
            writer.writeAll(",\"provider_name\":") catch return;
            writeJsonString(writer, row.provider_name) catch return;
            if (row.session_id) |session_id| {
                writer.writeAll(",\"session_id\":") catch return;
                writeJsonString(writer, session_id) catch return;
            }
            writer.writeAll(",\"status\":") catch return;
            writeJsonString(writer, row.status) catch return;
            writer.writeAll(",\"transcript\":") catch return;
            writeJsonString(writer, row.transcript) catch return;
            std.fmt.format(writer, ",\"started_at\":{d}", .{row.started_at}) catch return;
            if (row.ended_at) |ended_at| {
                std.fmt.format(writer, ",\"ended_at\":{d}", .{ended_at}) catch return;
            }
            writer.writeByte('}') catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, buf.items);
    }

    // -- Comment RPC handlers --

    fn rpcCommentCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };
        const content = getStr(params, "content") orelse "";
        const author_type = getStr(params, "author_type") orelse "agent";
        const author_id = getStr(params, "author_id") orelse "";
        const parent_comment_id = getStr(params, "parent_comment_id");

        const comment_id = std.fmt.allocPrint(self.allocator, "cmt-{d}", .{std.time.nanoTimestamp()}) catch return;
        defer self.allocator.free(comment_id);

        self.db.createComment(comment_id, task_id, author_type, author_id, content, parent_comment_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var buf: [4096]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('{') catch return;
        writer.writeAll("\"id\":") catch return;
        writeJsonString(writer, comment_id) catch return;
        writer.writeAll(",\"task_id\":") catch return;
        writeJsonString(writer, task_id) catch return;
        writer.writeAll(",\"author_type\":") catch return;
        writeJsonString(writer, author_type) catch return;
        writer.writeAll(",\"author_id\":") catch return;
        writeJsonString(writer, author_id) catch return;
        writer.writeAll(",\"content\":") catch return;
        writeJsonString(writer, content) catch return;
        if (parent_comment_id) |pid| {
            writer.writeAll(",\"parent_comment_id\":") catch return;
            writeJsonString(writer, pid) catch return;
        }
        writer.writeAll("}") catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcCommentList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };

        const rows = self.db.listComments(self.allocator, task_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer db_mod.freeCommentRows(self.allocator, rows);

        var buf: [16384]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            std.fmt.format(writer, "{{\"id\":\"{s}\",\"task_id\":\"{s}\",\"author_type\":\"{s}\",\"author_id\":\"{s}\"", .{ row.id, row.task_id, row.author_type, row.author_id }) catch return;
            writer.writeAll(",\"content\":") catch return;
            writeJsonString(writer, row.content) catch return;
            if (row.parent_comment_id) |p| {
                std.fmt.format(writer, ",\"parent_comment_id\":\"{s}\"", .{p}) catch return;
            }
            std.fmt.format(writer, ",\"created_at\":{d},\"updated_at\":{d}}}", .{ row.created_at, row.updated_at }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcCommentUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const comment_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        const content = getStr(params, "content") orelse {
            sendError(client, id, -32602, "Missing content");
            return;
        };

        self.db.updateComment(comment_id, content) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        sendResult(client, id, "true");
    }

    fn rpcCommentDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const comment_id = getStr(params, "id") orelse return;
        self.db.deleteComment(comment_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskBlock(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse return;
        self.db.updateTask(task_id, null, null, "blocked", null, null, null, null, null, null, null, null) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskCancel(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "id") orelse return;
        self.stopTaskExecution(task_id, "cancelled");
        self.db.resetTaskDispatch(task_id, false) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        self.db.updateTask(task_id, null, null, "cancelled", null, null, null, null, null, null, null, null) catch |err| {
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
        const provided_id = getStr(params, "id");
        const slot_id = getStr(params, "slot_id");

        const agent_id = provided_id orelse slot_id orelse blk: {
            const generated = std.fmt.allocPrint(self.allocator, "agent-{d}", .{std.time.timestamp()}) catch return;
            break :blk generated;
        };
        defer if (provided_id == null and slot_id == null) self.allocator.free(agent_id);

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
            if (params.get("clear_session_id")) |value| value == .bool and value.bool else false,
            if (params.get("clear_assignment")) |value| value == .bool and value.bool else false,
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
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"space_id\":") catch return;
            writeJsonString(writer, row.space_id) catch return;
            writer.writeAll(",\"provider_id\":") catch return;
            writeJsonString(writer, row.provider_id) catch return;
            writer.writeAll(",\"provider_name\":") catch return;
            writeJsonString(writer, row.provider_name) catch return;
            writer.writeAll(",\"status\":") catch return;
            writeJsonString(writer, row.status) catch return;
            if (row.session_id) |s| {
                writer.writeAll(",\"session_id\":") catch return;
                writeJsonString(writer, s) catch return;
            }
            if (row.assigned_task_id) |t| {
                writer.writeAll(",\"assigned_task_id\":") catch return;
                writeJsonString(writer, t) catch return;
            }
            if (row.prompt) |p| {
                writer.writeAll(",\"prompt\":") catch return;
                writeJsonString(writer, p) catch return;
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

    fn rpcSchedulerDispatch(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };

        self.scheduler_mutex.lock();
        defer self.scheduler_mutex.unlock();

        const assignments = self.db.dispatchQueuedTasks(self.allocator, space_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        defer db_mod.freeDispatchAssignments(self.allocator, assignments);

        var buf: [16384]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (assignments, 0..) |assignment, index| {
            if (index > 0) writer.writeByte(',') catch return;
            writer.writeAll("{\"task_id\":") catch return;
            writeJsonString(writer, assignment.task_id) catch return;
            writer.writeAll(",\"agent_id\":") catch return;
            writeJsonString(writer, assignment.agent_id) catch return;
            writer.writeByte('}') catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcSchedulerHandleSessionExit(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const session_id = getStr(params, "session_id") orelse {
            sendError(client, id, -32602, "Missing session_id");
            return;
        };

        self.scheduler_mutex.lock();
        defer self.scheduler_mutex.unlock();

        const binding = self.db.getSessionAgentBinding(self.allocator, session_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        } orelse {
            sendResult(client, id, "{\"kind\":\"none\"}");
            return;
        };
        defer db_mod.freeSessionAgentBinding(self.allocator, binding);

        var resp_buf: [1024]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&resp_buf);
        const writer = fbs.writer();
        writer.writeByte('{') catch return;

        if (binding.is_slot_agent) {
            if (binding.assigned_task_id) |task_id| {
                self.db.unassignTask(task_id) catch |err| {
                    sendError(client, id, -32000, @errorName(err));
                    return;
                };
                writer.writeAll("\"kind\":\"slot\",\"space_id\":") catch return;
                writeJsonString(writer, binding.space_id) catch return;
                writer.writeAll(",\"agent_id\":") catch return;
                writeJsonString(writer, binding.agent_id) catch return;
                writer.writeAll(",\"task_id\":") catch return;
                writeJsonString(writer, task_id) catch return;
                writer.writeAll(",\"task_status\":\"done\",\"queue_status\":\"completed\",\"agent_status\":\"idle\"") catch return;
            } else {
                self.db.updateAgent(binding.agent_id, "idle", null, null, true, true) catch |err| {
                    sendError(client, id, -32000, @errorName(err));
                    return;
                };
                writer.writeAll("\"kind\":\"slot\",\"space_id\":") catch return;
                writeJsonString(writer, binding.space_id) catch return;
                writer.writeAll(",\"agent_id\":") catch return;
                writeJsonString(writer, binding.agent_id) catch return;
                writer.writeAll(",\"agent_status\":\"idle\"") catch return;
            }
        } else {
            self.db.updateAgent(binding.agent_id, "exited", null, null, true, true) catch |err| {
                sendError(client, id, -32000, @errorName(err));
                return;
            };
            writer.writeAll("\"kind\":\"standalone\",\"space_id\":") catch return;
            writeJsonString(writer, binding.space_id) catch return;
            writer.writeAll(",\"agent_id\":") catch return;
            writeJsonString(writer, binding.agent_id) catch return;
            writer.writeAll(",\"agent_status\":\"exited\"") catch return;
        }

        writer.writeByte('}') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcSchedulerStopTask(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };
        const requeue = if (params.get("requeue")) |value| value == .bool and value.bool else false;

        self.scheduler_mutex.lock();
        defer self.scheduler_mutex.unlock();

        const binding = self.db.getTaskExecutionBinding(self.allocator, task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        } orelse {
            sendError(client, id, -32000, "Task not found");
            return;
        };
        defer db_mod.freeTaskExecutionBinding(self.allocator, binding);

        if (binding.session_id) |session_id_value| {
            self.sessions.kill(session_id_value);
        }

        self.db.resetTaskDispatch(task_id, requeue) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [1024]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&resp_buf);
        const writer = fbs.writer();
        writer.writeByte('{') catch return;
        writer.writeAll("\"space_id\":") catch return;
        writeJsonString(writer, binding.space_id) catch return;
        writer.writeAll(",\"task_id\":") catch return;
        writeJsonString(writer, task_id) catch return;
        writer.writeAll(",\"task_status\":\"todo\",\"queue_status\":") catch return;
        writeJsonString(writer, if (requeue) "queued" else "none") catch return;
        if (binding.assigned_agent_id) |agent_id| {
            writer.writeAll(",\"agent_id\":") catch return;
            writeJsonString(writer, agent_id) catch return;
        }
        if (binding.session_id) |session_id_value| {
            writer.writeAll(",\"session_id\":") catch return;
            writeJsonString(writer, session_id_value) catch return;
        }
        writer.writeAll(",\"agent_status\":\"idle\"") catch return;
        writer.writeByte('}') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcSchedulerAttachTaskSession(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse {
            sendError(client, id, -32602, "Missing task_id");
            return;
        };
        const session_id = getStr(params, "session_id") orelse {
            sendError(client, id, -32602, "Missing session_id");
            return;
        };

        self.scheduler_mutex.lock();
        defer self.scheduler_mutex.unlock();

        const binding = self.db.getTaskExecutionBinding(self.allocator, task_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        } orelse {
            sendError(client, id, -32000, "Task not found");
            return;
        };
        defer db_mod.freeTaskExecutionBinding(self.allocator, binding);

        const agent_id = binding.assigned_agent_id orelse {
            sendError(client, id, -32000, "Task is not assigned");
            return;
        };

        self.db.updateAgent(agent_id, null, session_id, null, false, false) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var resp_buf: [1024]u8 = undefined;
        const resp = std.fmt.bufPrint(
            &resp_buf,
            "{{\"space_id\":\"{s}\",\"task_id\":\"{s}\",\"agent_id\":\"{s}\",\"session_id\":\"{s}\",\"agent_status\":\"running\"}}",
            .{ binding.space_id, task_id, agent_id, session_id },
        ) catch return;
        sendResult(client, id, resp);
    }

    fn rpcSchedulerReconcileSpace(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const requeue = if (params.get("requeue")) |value| value == .bool and value.bool else true;

        self.scheduler_mutex.lock();
        defer self.scheduler_mutex.unlock();

        self.db.reconcileSlotDispatchState(self.allocator, space_id, requeue) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

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
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, ws.id) catch return;
            writer.writeAll(",\"name\":") catch return;
            writeJsonString(writer, ws.name) catch return;
            writer.writeAll(",\"path\":") catch return;
            writeJsonString(writer, ws.path) catch return;
            if (ws.active_space_id) |active_space_id| {
                writer.writeAll(",\"active_space_id\":") catch return;
                writeJsonString(writer, active_space_id) catch return;
            }
            writer.writeAll(",\"spaces\":[") catch return;

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
                writer.writeByte('{') catch return;
                writer.writeAll("\"id\":") catch return;
                writeJsonString(writer, sp.id) catch return;
                writer.writeAll(",\"name\":") catch return;
                writeJsonString(writer, sp.name) catch return;
                writer.writeAll(",\"directory_path\":") catch return;
                writeJsonString(writer, sp.directory_path) catch return;
                std.fmt.format(writer, ",\"sort_order\":{d},\"nodes\":[", .{sp.sort_order}) catch return;

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
                    writer.writeByte('{') catch return;
                    writer.writeAll("\"id\":") catch return;
                    writeJsonString(writer, node.id) catch return;
                    writer.writeAll(",\"kind\":") catch return;
                    writeJsonString(writer, node.kind) catch return;
                    writer.writeAll(",\"title\":") catch return;
                    writeJsonString(writer, node.title) catch return;
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
                        if (task.identifier) |v| self.allocator.free(v);
                        if (task.due_date) |v| self.allocator.free(v);
                        if (task.labels) |v| self.allocator.free(v);
                        if (task.completed_by_agent_id) |v| self.allocator.free(v);
                        if (task.project_id) |v| self.allocator.free(v);
                    }
                    self.allocator.free(tasks);
                }

                for (tasks, 0..) |task, ti| {
                    if (ti > 0) writer.writeByte(',') catch return;
                    writer.writeByte('{') catch return;
                    writer.writeAll("\"id\":") catch return;
                    writeJsonString(writer, task.id) catch return;
                    writer.writeAll(",\"space_id\":") catch return;
                    writeJsonString(writer, task.space_id) catch return;
                    writer.writeAll(",\"title\":") catch return;
                    writeJsonString(writer, task.title) catch return;
                    writer.writeAll(",\"description\":") catch return;
                    writeJsonString(writer, task.description) catch return;
                    writer.writeAll(",\"status\":") catch return;
                    writeJsonString(writer, task.status) catch return;
                    writer.writeAll(",\"priority\":") catch return;
                    writeJsonString(writer, task.priority) catch return;
                    writer.writeAll(",\"queue_status\":") catch return;
                    writeJsonString(writer, task.queue_status) catch return;
                    if (task.parent_task_id) |p| {
                        writer.writeAll(",\"parent_task_id\":") catch return;
                        writeJsonString(writer, p) catch return;
                    }
                    if (task.assigned_agent_id) |a| {
                        writer.writeAll(",\"assigned_agent_id\":") catch return;
                        writeJsonString(writer, a) catch return;
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
                    if (task.identifier) |v| {
                        writer.writeAll(",\"identifier\":") catch return;
                        writeJsonString(writer, v) catch return;
                    }
                    if (task.due_date) |v| {
                        writer.writeAll(",\"due_date\":") catch return;
                        writeJsonString(writer, v) catch return;
                    }
                    if (task.labels) |v| {
                        writer.writeAll(",\"labels\":") catch return;
                        writer.writeAll(v) catch return;
                    }
                    if (task.estimate) |v| {
                        std.fmt.format(writer, ",\"estimate\":{d}", .{v}) catch return;
                    }
                    if (task.completed_by_agent_id) |v| {
                        writer.writeAll(",\"completed_by_agent_id\":") catch return;
                        writeJsonString(writer, v) catch return;
                    }
                    if (task.project_id) |v| {
                        writer.writeAll(",\"project_id\":") catch return;
                        writeJsonString(writer, v) catch return;
                    }
                    std.fmt.format(writer, ",\"sort_order\":{d},\"created_at\":{d}}}", .{ task.sort_order, task.created_at }) catch return;
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
                    writer.writeByte('{') catch return;
                    writer.writeAll("\"id\":") catch return;
                    writeJsonString(writer, agent.id) catch return;
                    writer.writeAll(",\"space_id\":") catch return;
                    writeJsonString(writer, agent.space_id) catch return;
                    writer.writeAll(",\"provider_id\":") catch return;
                    writeJsonString(writer, agent.provider_id) catch return;
                    writer.writeAll(",\"provider_name\":") catch return;
                    writeJsonString(writer, agent.provider_name) catch return;
                    writer.writeAll(",\"status\":") catch return;
                    writeJsonString(writer, agent.status) catch return;
                    if (agent.session_id) |s| {
                        writer.writeAll(",\"session_id\":") catch return;
                        writeJsonString(writer, s) catch return;
                    }
                    if (agent.assigned_task_id) |t| {
                        writer.writeAll(",\"assigned_task_id\":") catch return;
                        writeJsonString(writer, t) catch return;
                    }
                    if (agent.prompt) |prompt| {
                        writer.writeAll(",\"prompt\":") catch return;
                        writeJsonString(writer, prompt) catch return;
                    }
                    if (agent.node_id) |node_id_value| {
                        writer.writeAll(",\"node_id\":") catch return;
                        writeJsonString(writer, node_id_value) catch return;
                    }
                    if (agent.started_at) |s| {
                        std.fmt.format(writer, ",\"started_at\":{d}", .{s}) catch return;
                    }
                    std.fmt.format(writer, ",\"sort_order\":{d},\"created_at\":{d}}}", .{ agent.sort_order, agent.created_at }) catch return;
                }
                const inbox_count = self.db.unreadInboxCount(sp.id);
                std.fmt.format(writer, "],\"unread_inbox_count\":{d}}}", .{inbox_count}) catch return;
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

    fn stopLiveSessions(self: *Server) void {
        var it = self.sessions.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.status == .running) {
                entry.value_ptr.pty_handle.kill();
                entry.value_ptr.status = .exited;
            }
        }
    }

    fn switchWorkspaceDb(self: *Server, db_path: []const u8) !void {
        self.stopLiveSessions();

        var next_db = try db_mod.Db.openAtPath(self.allocator, db_path);
        errdefer next_db.close();

        self.db.close();
        self.db = next_db;
        try db_mod.saveConfiguredDbPath(self.allocator, db_path);
    }

    fn rpcWorkspaceExportDb(self: *Server, id: ?std.json.Value, client: *Client) void {
        const file = std.fs.openFileAbsolute(self.db.path, .{}) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        defer file.close();

        const bytes = file.readToEndAlloc(self.allocator, 32 * 1024 * 1024) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        defer self.allocator.free(bytes);

        const encoded_len = std.base64.standard.Encoder.calcSize(bytes.len);
        const encoded = self.allocator.alloc(u8, encoded_len) catch {
            sendError(client, id, -32000, "OutOfMemory");
            return;
        };
        defer self.allocator.free(encoded);
        _ = std.base64.standard.Encoder.encode(encoded, bytes);

        const filename = std.fs.path.basename(self.db.path);
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(self.allocator);
        std.fmt.format(buf.writer(self.allocator), "{{\"filename\":\"{s}\",\"data\":\"{s}\"}}", .{ filename, encoded }) catch {
            sendError(client, id, -32000, "ResponseTooLarge");
            return;
        };
        sendResult(client, id, buf.items);
    }

    fn rpcWorkspaceImportDb(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const encoded = getStr(params, "data") orelse {
            sendError(client, id, -32602, "Missing data");
            return;
        };
        const filename = getStr(params, "filename") orelse "workspace";

        const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch {
            sendError(client, id, -32000, "InvalidBase64");
            return;
        };
        const decoded = self.allocator.alloc(u8, decoded_len) catch {
            sendError(client, id, -32000, "OutOfMemory");
            return;
        };
        defer self.allocator.free(decoded);

        std.base64.standard.Decoder.decode(decoded, encoded) catch {
            sendError(client, id, -32000, "InvalidBase64");
            return;
        };

        const target_path = db_mod.createManagedWorkspaceDbPath(self.allocator, filename) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        defer self.allocator.free(target_path);

        var out = std.fs.createFileAbsolute(target_path, .{ .truncate = true }) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        defer out.close();
        out.writeAll(decoded[0..decoded_len]) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        self.switchWorkspaceDb(target_path) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        sendResult(client, id, "true");
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

    fn rpcTaskLiveOutputSave(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse return;
        const session_id = getStr(params, "session_id") orelse return;
        const data = getStr(params, "data") orelse return;
        self.db.saveTaskLiveOutput(task_id, session_id, data) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcTaskLiveOutputLoad(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const task_id = getStr(params, "task_id") orelse return;
        const session_id = getStr(params, "session_id") orelse return;
        const data = self.db.loadTaskLiveOutput(self.allocator, task_id, session_id) catch null;
        if (data) |loaded| {
            defer self.allocator.free(loaded);
            const encoded_len = std.base64.standard.Encoder.calcSize(loaded.len);
            const encoded = self.allocator.alloc(u8, encoded_len) catch return;
            defer self.allocator.free(encoded);
            _ = std.base64.standard.Encoder.encode(encoded, loaded);

            const json = std.fmt.allocPrint(self.allocator, "{{\"data\":\"{s}\"}}", .{encoded}) catch return;
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
                    if (sess.kind == .agent) {
                        self.db.finishTaskRun(entry.key_ptr.*, "completed") catch {};
                        self.reconcileAgentSessionExit(entry.key_ptr.*);
                    }
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

        const msg = std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"method\":\"pty.data\",\"params\":{{\"session_id\":\"{s}\",\"data\":\"{s}\"}}}}", .{ session_id, b64_buf }) catch return;
        defer self.allocator.free(msg);
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

    // -- Project RPC --

    fn rpcProjectCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const name = getStr(params, "name") orelse "";
        const description = getStr(params, "description") orelse "";

        const proj_id = std.fmt.allocPrint(self.allocator, "proj-{d}", .{std.time.nanoTimestamp()}) catch return;
        defer self.allocator.free(proj_id);

        self.db.createProject(proj_id, space_id, name, description) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var buf: [2048]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('{') catch return;
        writer.writeAll("\"id\":") catch return;
        writeJsonString(writer, proj_id) catch return;
        writer.writeAll(",\"space_id\":") catch return;
        writeJsonString(writer, space_id) catch return;
        writer.writeAll(",\"name\":") catch return;
        writeJsonString(writer, name) catch return;
        writer.writeAll(",\"description\":") catch return;
        writeJsonString(writer, description) catch return;
        writer.writeAll(",\"status\":\"active\"}") catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcProjectList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const rows = self.db.listProjects(self.allocator, space_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.space_id);
                self.allocator.free(row.name);
                self.allocator.free(row.description);
                self.allocator.free(row.status);
            }
            self.allocator.free(rows);
        }
        var buf: [32768]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"space_id\":") catch return;
            writeJsonString(writer, row.space_id) catch return;
            writer.writeAll(",\"name\":") catch return;
            writeJsonString(writer, row.name) catch return;
            writer.writeAll(",\"description\":") catch return;
            writeJsonString(writer, row.description) catch return;
            writer.writeAll(",\"status\":") catch return;
            writeJsonString(writer, row.status) catch return;
            std.fmt.format(writer, ",\"created_at\":{d}}}", .{row.created_at}) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcProjectUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const proj_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        self.db.updateProject(proj_id, getStr(params, "name"), getStr(params, "description"), getStr(params, "status")) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcProjectDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const proj_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        self.db.deleteProject(proj_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    // -- Inbox RPC --

    fn rpcInboxList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const rows = self.db.listInboxItems(self.allocator, space_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.space_id);
                self.allocator.free(row.item_type);
                self.allocator.free(row.item_id);
                self.allocator.free(row.message);
            }
            self.allocator.free(rows);
        }
        var buf: [32768]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"space_id\":") catch return;
            writeJsonString(writer, row.space_id) catch return;
            writer.writeAll(",\"item_type\":") catch return;
            writeJsonString(writer, row.item_type) catch return;
            writer.writeAll(",\"item_id\":") catch return;
            writeJsonString(writer, row.item_id) catch return;
            writer.writeAll(",\"message\":") catch return;
            writeJsonString(writer, row.message) catch return;
            std.fmt.format(writer, ",\"read\":{s},\"created_at\":{d}}}", .{ if (row.read) "true" else "false", row.created_at }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcInboxMarkRead(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const item_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        self.db.markInboxItemRead(item_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcInboxMarkAllRead(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        self.db.markAllInboxItemsRead(space_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    // -- Autopilot RPC --

    fn rpcAutopilotCreate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const name = getStr(params, "name") orelse "";
        const trigger_config = getStr(params, "trigger_config") orelse "{}";
        const action_config = getStr(params, "action_config") orelse "{}";

        const ap_id = std.fmt.allocPrint(self.allocator, "ap-{d}", .{std.time.nanoTimestamp()}) catch return;
        defer self.allocator.free(ap_id);

        self.db.createAutopilot(ap_id, space_id, name, trigger_config, action_config) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };

        var buf: [2048]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('{') catch return;
        writer.writeAll("\"id\":") catch return;
        writeJsonString(writer, ap_id) catch return;
        writer.writeAll(",\"space_id\":") catch return;
        writeJsonString(writer, space_id) catch return;
        writer.writeAll(",\"name\":") catch return;
        writeJsonString(writer, name) catch return;
        writer.writeAll(",\"trigger_config\":") catch return;
        writer.writeAll(trigger_config) catch return;
        writer.writeAll(",\"action_config\":") catch return;
        writer.writeAll(action_config) catch return;
        writer.writeAll(",\"enabled\":true}") catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcAutopilotList(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const space_id = getStr(params, "space_id") orelse {
            sendError(client, id, -32602, "Missing space_id");
            return;
        };
        const rows = self.db.listAutopilots(self.allocator, space_id) catch {
            sendResult(client, id, "[]");
            return;
        };
        defer {
            for (rows) |row| {
                self.allocator.free(row.id);
                self.allocator.free(row.space_id);
                self.allocator.free(row.name);
                self.allocator.free(row.trigger_config);
                self.allocator.free(row.action_config);
            }
            self.allocator.free(rows);
        }
        var buf: [32768]u8 = undefined;
        var fbs = std.io.fixedBufferStream(&buf);
        const writer = fbs.writer();
        writer.writeByte('[') catch return;
        for (rows, 0..) |row, i| {
            if (i > 0) writer.writeByte(',') catch return;
            writer.writeByte('{') catch return;
            writer.writeAll("\"id\":") catch return;
            writeJsonString(writer, row.id) catch return;
            writer.writeAll(",\"space_id\":") catch return;
            writeJsonString(writer, row.space_id) catch return;
            writer.writeAll(",\"name\":") catch return;
            writeJsonString(writer, row.name) catch return;
            writer.writeAll(",\"trigger_config\":") catch return;
            writer.writeAll(row.trigger_config) catch return;
            writer.writeAll(",\"action_config\":") catch return;
            writer.writeAll(row.action_config) catch return;
            std.fmt.format(writer, ",\"enabled\":{s},\"created_at\":{d}}}", .{ if (row.enabled) "true" else "false", row.created_at }) catch return;
        }
        writer.writeByte(']') catch return;
        sendResult(client, id, fbs.getWritten());
    }

    fn rpcAutopilotUpdate(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const ap_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        self.db.updateAutopilot(ap_id, getStr(params, "name"), getStr(params, "trigger_config"), getStr(params, "action_config")) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcAutopilotDelete(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const ap_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        self.db.deleteAutopilot(ap_id) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
    }

    fn rpcAutopilotSetEnabled(self: *Server, params: std.json.ObjectMap, id: ?std.json.Value, client: *Client) void {
        const ap_id = getStr(params, "id") orelse {
            sendError(client, id, -32602, "Missing id");
            return;
        };
        const enabled_val = params.get("enabled") orelse {
            sendError(client, id, -32602, "Missing enabled");
            return;
        };
        const enabled = switch (enabled_val) {
            .bool => |b| b,
            else => {
                sendError(client, id, -32602, "enabled must be boolean");
                return;
            },
        };
        self.db.setAutopilotEnabled(ap_id, enabled) catch |err| {
            sendError(client, id, -32000, @errorName(err));
            return;
        };
        sendResult(client, id, "true");
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

fn writeJsonString(writer: anytype, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |ch| {
        switch (ch) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            else => try writer.writeByte(ch),
        }
    }
    try writer.writeByte('"');
}

fn sendResult(client: *Client, id: ?std.json.Value, result: []const u8) void {
    var id_buf: [32]u8 = undefined;
    const id_str = formatId(id, &id_buf);
    const msg = std.fmt.allocPrint(client.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}", .{ id_str, result }) catch return;
    defer client.allocator.free(msg);
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
