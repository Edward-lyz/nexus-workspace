const std = @import("std");
const c = @cImport({
    @cInclude("objc/runtime.h");
    @cInclude("objc/message.h");
});

// Objective-C runtime helpers
fn objc_getClass(name: [*:0]const u8) ?*anyopaque {
    return @as(?*anyopaque, @ptrCast(c.objc_getClass(name)));
}

fn sel(name: [*:0]const u8) c.SEL {
    return c.sel_registerName(name);
}

// Type-specific msgSend wrappers
fn msg0(obj: ?*anyopaque, selector: c.SEL) ?*anyopaque {
    const f: *const fn (?*anyopaque, c.SEL) callconv(.c) ?*anyopaque = @ptrCast(&c.objc_msgSend);
    return f(obj, selector);
}

fn msg1(obj: ?*anyopaque, selector: c.SEL, a1: ?*anyopaque) ?*anyopaque {
    const f: *const fn (?*anyopaque, c.SEL, ?*anyopaque) callconv(.c) ?*anyopaque = @ptrCast(&c.objc_msgSend);
    return f(obj, selector, a1);
}

fn msg3(obj: ?*anyopaque, selector: c.SEL, a1: ?*anyopaque, a2: c.SEL, a3: ?*anyopaque) ?*anyopaque {
    const f: *const fn (?*anyopaque, c.SEL, ?*anyopaque, c.SEL, ?*anyopaque) callconv(.c) ?*anyopaque = @ptrCast(&c.objc_msgSend);
    return f(obj, selector, a1, a2, a3);
}

fn msgBool(obj: ?*anyopaque, selector: c.SEL, val: bool) void {
    const f: *const fn (?*anyopaque, c.SEL, c_int) callconv(.c) void = @ptrCast(&c.objc_msgSend);
    f(obj, selector, if (val) 1 else 0);
}

fn msgInt64(obj: ?*anyopaque, selector: c.SEL) i64 {
    const f: *const fn (?*anyopaque, c.SEL) callconv(.c) i64 = @ptrCast(&c.objc_msgSend);
    return f(obj, selector);
}

fn msgUInt64(obj: ?*anyopaque, selector: c.SEL) u64 {
    const f: *const fn (?*anyopaque, c.SEL) callconv(.c) u64 = @ptrCast(&c.objc_msgSend);
    return f(obj, selector);
}

fn msgIdx(obj: ?*anyopaque, selector: c.SEL, idx: u64) ?*anyopaque {
    const f: *const fn (?*anyopaque, c.SEL, u64) callconv(.c) ?*anyopaque = @ptrCast(&c.objc_msgSend);
    return f(obj, selector, idx);
}

fn msgInsert(obj: ?*anyopaque, selector: c.SEL, item: ?*anyopaque, idx: i64) void {
    const f: *const fn (?*anyopaque, c.SEL, ?*anyopaque, i64) callconv(.c) void = @ptrCast(&c.objc_msgSend);
    f(obj, selector, item, idx);
}

fn msgStr(obj: ?*anyopaque, selector: c.SEL) ?[*:0]const u8 {
    const f: *const fn (?*anyopaque, c.SEL) callconv(.c) ?[*:0]const u8 = @ptrCast(&c.objc_msgSend);
    return f(obj, selector);
}

fn createNSString(str: [*:0]const u8) ?*anyopaque {
    const NSString = objc_getClass("NSString") orelse return null;
    const alloc = msg0(NSString, sel("alloc")) orelse return null;
    return msg1(alloc, sel("initWithUTF8String:"), @as(?*anyopaque, @ptrCast(@constCast(str))));
}

/// Setup standard macOS menus with keyboard shortcuts
pub fn setupEditMenu() void {
    const NSApplication = objc_getClass("NSApplication") orelse return;
    const NSMenu = objc_getClass("NSMenu") orelse return;
    const NSMenuItem = objc_getClass("NSMenuItem") orelse return;

    const app = msg0(NSApplication, sel("sharedApplication")) orelse return;
    const mainMenu = msg0(app, sel("mainMenu")) orelse return;

    // Create App menu with Quit
    const appMenuTitle = createNSString("Nexus") orelse return;
    const appMenuAlloc = msg0(NSMenu, sel("alloc")) orelse return;
    const appMenu = msg1(appMenuAlloc, sel("initWithTitle:"), appMenuTitle) orelse return;

    // Add Quit item
    const quitTitle = createNSString("Quit Nexus") orelse return;
    const quitKey = createNSString("q") orelse return;
    const quitItemAlloc = msg0(NSMenuItem, sel("alloc")) orelse return;
    const quitItem = msg3(quitItemAlloc, sel("initWithTitle:action:keyEquivalent:"), quitTitle, sel("terminate:"), quitKey) orelse return;
    _ = msg1(appMenu, sel("addItem:"), quitItem);

    // Create App menu item for menu bar
    const appMenuItemAlloc = msg0(NSMenuItem, sel("alloc")) orelse return;
    const appMenuItem = msg0(appMenuItemAlloc, sel("init")) orelse return;
    _ = msg1(appMenuItem, sel("setSubmenu:"), appMenu);
    msgInsert(mainMenu, sel("insertItem:atIndex:"), appMenuItem, 0);

    // Create Edit menu
    const editMenuTitle = createNSString("Edit") orelse return;
    const editMenuAlloc = msg0(NSMenu, sel("alloc")) orelse return;
    const editMenu = msg1(editMenuAlloc, sel("initWithTitle:"), editMenuTitle) orelse return;

    // Add standard edit items
    const items = [_]struct { title: [*:0]const u8, action: [*:0]const u8, key: [*:0]const u8 }{
        .{ .title = "Undo", .action = "undo:", .key = "z" },
        .{ .title = "Redo", .action = "redo:", .key = "Z" },
        .{ .title = "Cut", .action = "cut:", .key = "x" },
        .{ .title = "Copy", .action = "copy:", .key = "c" },
        .{ .title = "Paste", .action = "paste:", .key = "v" },
        .{ .title = "Select All", .action = "selectAll:", .key = "a" },
    };

    for (items) |item| {
        const title = createNSString(item.title) orelse continue;
        const key = createNSString(item.key) orelse continue;
        const action = sel(item.action);

        const menuItemAlloc = msg0(NSMenuItem, sel("alloc")) orelse continue;
        const menuItem = msg3(menuItemAlloc, sel("initWithTitle:action:keyEquivalent:"), title, action, key) orelse continue;

        _ = msg1(editMenu, sel("addItem:"), menuItem);
    }

    // Create Edit menu item for menu bar
    const editMenuItemAlloc = msg0(NSMenuItem, sel("alloc")) orelse return;
    const editMenuItem = msg0(editMenuItemAlloc, sel("init")) orelse return;
    _ = msg1(editMenuItem, sel("setSubmenu:"), editMenu);

    // Add to main menu
    _ = msg1(mainMenu, sel("addItem:"), editMenuItem);
}

// Context for folder picker callback
const FolderPickerContext = struct {
    result: ?[]u8 = null,
    allocator: std.mem.Allocator,
};

// External dispatch function
extern "c" fn dispatch_sync_f(queue: *anyopaque, context: ?*anyopaque, work: *const fn (?*anyopaque) callconv(.c) void) void;
extern "c" var _dispatch_main_q: anyopaque;

fn getMainQueue() *anyopaque {
    return &_dispatch_main_q;
}

/// Show native folder picker dialog, returns selected path or null
/// Must dispatch to main thread for GUI operations
pub fn showFolderPicker(allocator: std.mem.Allocator) ?[]u8 {
    var ctx = FolderPickerContext{ .allocator = allocator };

    // Dispatch to main thread synchronously
    dispatch_sync_f(getMainQueue(), @ptrCast(&ctx), struct {
        fn work(context: ?*anyopaque) callconv(.c) void {
            const c2: *FolderPickerContext = @ptrCast(@alignCast(context));
            c2.result = doShowFolderPicker(c2.allocator);
        }
    }.work);

    return ctx.result;
}

fn doShowFolderPicker(allocator: std.mem.Allocator) ?[]u8 {
    const NSOpenPanel = objc_getClass("NSOpenPanel") orelse return null;

    const panel = msg0(NSOpenPanel, sel("openPanel")) orelse return null;

    // Configure panel
    msgBool(panel, sel("setCanChooseFiles:"), false);
    msgBool(panel, sel("setCanChooseDirectories:"), true);
    msgBool(panel, sel("setAllowsMultipleSelection:"), false);

    // Run modal - NSModalResponseOK = 1
    const result = msgInt64(panel, sel("runModal"));
    if (result != 1) return null;

    // Get selected URL
    const urls = msg0(panel, sel("URLs")) orelse return null;
    const count = msgUInt64(urls, sel("count"));
    if (count == 0) return null;

    const url = msgIdx(urls, sel("objectAtIndex:"), 0) orelse return null;
    const pathObj = msg0(url, sel("path")) orelse return null;

    // Get UTF8 string
    const utf8 = msgStr(pathObj, sel("UTF8String")) orelse return null;

    // Copy to Zig allocator
    const len = std.mem.len(utf8);
    const buf = allocator.alloc(u8, len) catch return null;
    @memcpy(buf, utf8[0..len]);
    return buf;
}
