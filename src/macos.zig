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

fn msgStr(obj: ?*anyopaque, selector: c.SEL) ?[*:0]const u8 {
    const f: *const fn (?*anyopaque, c.SEL) callconv(.c) ?[*:0]const u8 = @ptrCast(&c.objc_msgSend);
    return f(obj, selector);
}

fn createNSString(str: [*:0]const u8) ?*anyopaque {
    const NSString = objc_getClass("NSString") orelse return null;
    const alloc = msg0(NSString, sel("alloc")) orelse return null;
    return msg1(alloc, sel("initWithUTF8String:"), @as(?*anyopaque, @ptrCast(@constCast(str))));
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
