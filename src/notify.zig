const std = @import("std");

pub const NotificationKind = enum {
    agent_standby,
    task_completed,
    task_failed,
    agent_output,
};

/// Send a macOS notification using osascript
pub fn sendNotification(
    allocator: std.mem.Allocator,
    title: []const u8,
    body: []const u8,
) !void {
    // Escape quotes in title and body
    var title_escaped: std.ArrayList(u8) = .empty;
    defer title_escaped.deinit(allocator);
    for (title) |ch| {
        if (ch == '"' or ch == '\\') try title_escaped.append(allocator, '\\');
        try title_escaped.append(allocator, ch);
    }

    var body_escaped: std.ArrayList(u8) = .empty;
    defer body_escaped.deinit(allocator);
    for (body) |ch| {
        if (ch == '"' or ch == '\\') try body_escaped.append(allocator, '\\');
        try body_escaped.append(allocator, ch);
    }

    var script_buf: [2048]u8 = undefined;
    const script = std.fmt.bufPrint(&script_buf, "display notification \"{s}\" with title \"{s}\"", .{
        body_escaped.items,
        title_escaped.items,
    }) catch return;

    // Run osascript in background
    _ = std.process.Child.run(.{
        .allocator = allocator,
        .argv = &[_][]const u8{ "osascript", "-e", script },
    }) catch return;
}

/// Check if text contains any standby patterns that indicate the agent needs attention
pub fn containsStandbyPattern(text: []const u8) bool {
    const patterns = [_][]const u8{
        "Waiting for user input",
        "Press enter to continue",
        "Do you want to proceed",
        "(Y/n)",
        "(y/N)",
        "[y/n]",
        "Continue?",
        "Proceed?",
        "Permission denied",
        "requires approval",
    };

    for (patterns) |pattern| {
        if (std.mem.indexOf(u8, text, pattern) != null) return true;
    }
    return false;
}
