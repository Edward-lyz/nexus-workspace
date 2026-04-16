const std = @import("std");
const ipc = @import("./src/ipc.zig");
const db_mod = @import("./src/db.zig");

pub fn main() !void {
    var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .{};
    defer _ = gpa_state.deinit();
    const allocator = gpa_state.allocator();

    const db_path = std.posix.getenv("NEXUS_INTEGRATION_DB_PATH") orelse "/tmp/nexus-integration.sqlite";
    const db = try db_mod.Db.openAtPath(allocator, db_path);
    var server = try ipc.Server.init(allocator, ".", db);
    defer server.deinit();

    std.debug.print("PORT={d}\n", .{server.port});
    ipc.Server.run(&server);
}
