const std = @import("std");

pub const LayoutMode = enum {
    auto,
    columns,
    rows,
    main_stack,
};

pub const CellRect = struct {
    id: usize,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
};

pub fn computeLayout(
    allocator: std.mem.Allocator,
    screen_w: u32,
    screen_h: u32,
    cell_count: usize,
    gap: u32,
    mode: LayoutMode,
) ![]CellRect {
    if (cell_count == 0) return &.{};

    const cells = try allocator.alloc(CellRect, cell_count);
    errdefer allocator.free(cells);

    switch (mode) {
        .auto => computeAuto(cells, screen_w, screen_h, gap),
        .columns => computeColumns(cells, screen_w, screen_h, gap),
        .rows => computeRows(cells, screen_w, screen_h, gap),
        .main_stack => computeMainStack(cells, screen_w, screen_h, gap),
    }

    return cells;
}

fn computeAuto(cells: []CellRect, sw: u32, sh: u32, gap: u32) void {
    const n = cells.len;
    const cols = intSqrtCeil(n);
    const rows_count = divCeil(n, cols);

    const cell_w = (sw -| gap * @as(u32, @intCast(cols + 1))) / @as(u32, @intCast(cols));
    const cell_h = (sh -| gap * @as(u32, @intCast(rows_count + 1))) / @as(u32, @intCast(rows_count));

    for (cells, 0..) |*cell, i| {
        const col: u32 = @intCast(i % cols);
        const row: u32 = @intCast(i / cols);
        cell.* = .{
            .id = i,
            .x = gap + col * (cell_w + gap),
            .y = gap + row * (cell_h + gap),
            .w = cell_w,
            .h = cell_h,
        };
    }
}

fn computeColumns(cells: []CellRect, sw: u32, sh: u32, gap: u32) void {
    const n: u32 = @intCast(cells.len);
    const cell_w = (sw -| gap * (n + 1)) / n;
    const cell_h = sh -| gap * 2;

    for (cells, 0..) |*cell, i| {
        const col: u32 = @intCast(i);
        cell.* = .{
            .id = i,
            .x = gap + col * (cell_w + gap),
            .y = gap,
            .w = cell_w,
            .h = cell_h,
        };
    }
}

fn computeRows(cells: []CellRect, sw: u32, sh: u32, gap: u32) void {
    const n: u32 = @intCast(cells.len);
    const cell_w = sw -| gap * 2;
    const cell_h = (sh -| gap * (n + 1)) / n;

    for (cells, 0..) |*cell, i| {
        const row: u32 = @intCast(i);
        cell.* = .{
            .id = i,
            .x = gap,
            .y = gap + row * (cell_h + gap),
            .w = cell_w,
            .h = cell_h,
        };
    }
}

fn computeMainStack(cells: []CellRect, sw: u32, sh: u32, gap: u32) void {
    if (cells.len == 1) {
        cells[0] = .{ .id = 0, .x = gap, .y = gap, .w = sw -| gap * 2, .h = sh -| gap * 2 };
        return;
    }

    const main_w = (sw -| gap * 3) * 6 / 10;
    const stack_w = sw -| main_w -| gap * 3;
    const stack_count: u32 = @intCast(cells.len - 1);
    const stack_h = (sh -| gap * (stack_count + 1)) / stack_count;

    cells[0] = .{
        .id = 0,
        .x = gap,
        .y = gap,
        .w = main_w,
        .h = sh -| gap * 2,
    };

    for (cells[1..], 0..) |*cell, i| {
        const row: u32 = @intCast(i);
        cell.* = .{
            .id = i + 1,
            .x = main_w + gap * 2,
            .y = gap + row * (stack_h + gap),
            .w = stack_w,
            .h = stack_h,
        };
    }
}

fn intSqrtCeil(n: usize) usize {
    if (n == 0) return 0;
    var x: usize = 1;
    while (x * x < n) : (x += 1) {}
    return x;
}

fn divCeil(a: usize, b: usize) usize {
    return (a + b - 1) / b;
}

test "auto layout 4 cells" {
    const allocator = std.testing.allocator;
    const cells = try computeLayout(allocator, 1200, 800, 4, 8, .auto);
    defer allocator.free(cells);

    try std.testing.expectEqual(@as(usize, 4), cells.len);
    try std.testing.expectEqual(@as(u32, 8), cells[0].x);
    try std.testing.expectEqual(@as(u32, 8), cells[0].y);
}

test "main_stack layout 3 cells" {
    const allocator = std.testing.allocator;
    const cells = try computeLayout(allocator, 1200, 800, 3, 8, .main_stack);
    defer allocator.free(cells);

    try std.testing.expectEqual(@as(usize, 3), cells.len);
    try std.testing.expect(cells[0].w > cells[1].w);
}
