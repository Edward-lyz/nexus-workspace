const std = @import("std");

const ipc = @import("ipc.zig");
const db_mod = @import("db.zig");

// Signal flag: set by SIGINT/SIGTERM handler
var should_exit = std.atomic.Value(bool).init(false);

pub fn main() !void {
    var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .{};
    defer _ = gpa_state.deinit();
    const allocator = gpa_state.allocator();

    // Open database
    const db = try db_mod.Db.open(allocator);

    // Resolve frontend dist directory
    const static_root = resolveFrontendDir(allocator) catch |err| {
        std.log.err("frontend dist not found: {}", .{err});
        std.log.err("Run 'cd frontend-v2 && bun run build' first.", .{});
        return err;
    };
    defer allocator.free(static_root);

    // Start IPC server
    var server = try ipc.Server.init(allocator, static_root, db);
    defer server.deinit();

    const server_thread = try std.Thread.spawn(.{}, ipc.Server.run, .{&server});
    defer {
        server.stop();
        server_thread.join();
    }

    // Print URL
    const url = try std.fmt.allocPrintSentinel(allocator, "http://127.0.0.1:{d}", .{server.port}, 0);
    defer allocator.free(url);

    std.log.info("Nexus daemon running at {s}", .{url});
    std.log.info("Press Ctrl+C to stop.", .{});

    // Open browser
    openBrowser(url);

    // Setup signal handlers
    setupSignalHandlers();

    // Block main thread until signal arrives
    while (!should_exit.load(.seq_cst)) {
        std.Thread.sleep(1 * std.time.ns_per_s);
    }

    std.log.info("Shutting down...", .{});
}

fn setupSignalHandlers() void {
    const os = std.posix;
    const act = std.posix.Sigaction{
        .handler = .{ .handler = handleSignal },
        .mask = @as(std.posix.sigset_t, 0),
        .flags = 0,
    };
    os.sigaction(os.SIG.INT, &act, null);
    os.sigaction(os.SIG.TERM, &act, null);
}

fn handleSignal(_: c_int) callconv(.c) void {
    should_exit.store(true, .seq_cst);
}

fn openBrowser(url: []const u8) void {
    const pid = std.posix.fork() catch {
        std.log.warn("Failed to fork for browser open. Open manually: {s}", .{url});
        return;
    };

    if (pid == 0) {
        // Child process: exec /usr/bin/open <url>
        const argv = [_:null]?[*:0]const u8{ "/usr/bin/open", @ptrCast(url.ptr), null };
        std.posix.execveZ("/usr/bin/open", &argv, @ptrCast(std.os.environ.ptr)) catch {
            std.posix.exit(1);
        };
        std.posix.exit(1);
    }

    // Parent: wait for child (open returns immediately)
    _ = std.posix.waitpid(pid, 0);
}

fn resolveFrontendDir(allocator: std.mem.Allocator) ![]u8 {
    const candidates = [_][]const u8{
        "frontend-v2/dist",
        "frontend/dist",
        "../frontend-v2/dist",
        "../frontend/dist",
        "../../frontend-v2/dist",
        "../../frontend/dist",
        "../Resources/static", // macOS .app bundle
    };

    const cwd = try std.process.getCwdAlloc(allocator);
    defer allocator.free(cwd);

    for (candidates) |rel| {
        const full = try std.fs.path.join(allocator, &.{ cwd, rel });
        const index_path = try std.fs.path.join(allocator, &.{ full, "index.html" });
        defer allocator.free(index_path);

        if (std.fs.cwd().access(index_path, .{})) |_| {
            return full;
        } else |_| {
            allocator.free(full);
        }
    }

    const exe_dir = try std.fs.selfExeDirPathAlloc(allocator);
    defer allocator.free(exe_dir);

    for (candidates) |rel| {
        const full = try std.fs.path.join(allocator, &.{ exe_dir, rel });
        const index_path = try std.fs.path.join(allocator, &.{ full, "index.html" });
        defer allocator.free(index_path);

        if (std.fs.cwd().access(index_path, .{})) |_| {
            return full;
        } else |_| {
            allocator.free(full);
        }
    }

    return error.FrontendNotFound;
}
