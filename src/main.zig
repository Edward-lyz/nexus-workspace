const std = @import("std");
const Webview = @import("webview").Webview;

const ipc = @import("ipc.zig");
const db_mod = @import("db.zig");
const macos = @import("macos.zig");

pub fn main() !void {
    var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .{};
    defer _ = gpa_state.deinit();
    const allocator = gpa_state.allocator();

    // Open database
    const db = try db_mod.Db.open(allocator);

    // Resolve frontend dist directory
    const static_root = resolveFrontendDir(allocator) catch |err| {
        std.log.err("frontend dist not found: {}", .{err});
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

    // Launch WebView on main thread (macOS requires main thread for UI)
    const w = try Webview.create(true, null);
    defer w.destroy() catch {};

    // Setup macOS menus AFTER webview creates the app (Cmd+Q, Cmd+C/V/X/A/Z)
    macos.setupEditMenu();

    try w.setTitle("Nexus");
    try w.setSize(1200, 800, .none);

    const url = try std.fmt.allocPrintSentinel(allocator, "http://127.0.0.1:{d}", .{server.port}, 0);
    defer allocator.free(url);

    try w.navigate(url);
    try w.run();
}

fn resolveFrontendDir(allocator: std.mem.Allocator) ![]u8 {
    const candidates = [_][]const u8{
        "frontend/dist",
        "../frontend/dist",
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
