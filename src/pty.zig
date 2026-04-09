const std = @import("std");
const posix = std.posix;

pub const PtyHandle = struct {
    master_fd: posix.fd_t,
    child_pid: posix.pid_t,
    allocator: std.mem.Allocator,

    pub fn write(self: *PtyHandle, data: []const u8) !usize {
        return posix.write(self.master_fd, data);
    }

    pub fn read(self: *PtyHandle, buf: []u8) !usize {
        return posix.read(self.master_fd, buf);
    }

    pub fn resize(self: *PtyHandle, cols: u16, rows: u16) !void {
        const ws = std.c.winsize{
            .col = cols,
            .row = rows,
            .xpixel = 0,
            .ypixel = 0,
        };
        const TIOCSWINSZ: c_int = @bitCast(@as(c_uint, 0x80087467));
        if (std.c.ioctl(self.master_fd, TIOCSWINSZ, @intFromPtr(&ws)) != 0) {
            return error.IoctlFailed;
        }
    }

    pub fn kill(self: *PtyHandle) void {
        posix.kill(self.child_pid, posix.SIG.TERM) catch {};
        _ = posix.waitpid(self.child_pid, 0);
        posix.close(self.master_fd);
    }

    pub fn getFd(self: *const PtyHandle) posix.fd_t {
        return self.master_fd;
    }
};

pub fn spawn(
    allocator: std.mem.Allocator,
    cwd: ?[]const u8,
    cols: u16,
    rows: u16,
    command: ?[]const u8,
) !PtyHandle {
    var ws = std.c.winsize{
        .col = cols,
        .row = rows,
        .xpixel = 0,
        .ypixel = 0,
    };

    var master_fd: posix.fd_t = undefined;
    const pid = forkpty(&master_fd, null, null, &ws);

    if (pid < 0) return error.ForkPtyFailed;

    if (pid == 0) {
        // Child process
        if (cwd) |dir| {
            std.posix.chdir(dir) catch {};
        }

        // Set environment variables - these modify the process environment
        _ = setenv("TERM", "xterm-256color", 1);

        // Ensure common user bin paths are in PATH for macOS app bundles
        const current_path = std.posix.getenv("PATH") orelse "/usr/bin:/bin";
        const home = std.posix.getenv("HOME") orelse "";
        const extended_path = buildExtendedPath(allocator, home, current_path) catch std.posix.exit(1);
        defer allocator.free(extended_path);
        _ = setenv("PATH", extended_path, 1);

        // Source user profile to get additional env vars (ANTHROPIC_API_KEY, etc.)
        // Use login shell which sources .zprofile/.bash_profile
        if (command) |cmd| {
            // Wrap command in login shell to get full environment
            const shell = std.posix.getenv("SHELL") orelse "/bin/zsh";
            const wrapped_cmd = buildWrappedCommand(allocator, cmd) catch std.posix.exit(1);
            defer allocator.free(wrapped_cmd);
            const argv = [_:null]?[*:0]const u8{
                @ptrCast(shell),
                "-l".ptr,
                "-c".ptr,
                wrapped_cmd.ptr,
                null,
            };
            // Use current environ which now includes our setenv changes
            const envp = @as([*:null]const ?[*:0]const u8, @ptrCast(std.c.environ));
            std.posix.execvpeZ(@ptrCast(shell), &argv, envp) catch {};
        } else {
            const shell = std.posix.getenv("SHELL") orelse "/bin/zsh";
            const login_name = buildLoginArg0(allocator, shell) catch std.posix.exit(1);
            defer allocator.free(login_name);

            const argv = [_:null]?[*:0]const u8{
                login_name.ptr,
                null,
            };
            const envp = @as([*:null]const ?[*:0]const u8, @ptrCast(std.c.environ));
            std.posix.execvpeZ(@ptrCast(shell), &argv, envp) catch {};
        }
        std.posix.exit(1);
    }

    // Parent: set non-blocking
    const F_GETFL = 3;
    const F_SETFL = 4;
    const O_NONBLOCK = 0x0004;
    const current_flags = try posix.fcntl(master_fd, F_GETFL, 0);
    _ = try posix.fcntl(master_fd, F_SETFL, current_flags | O_NONBLOCK);

    return PtyHandle{
        .master_fd = master_fd,
        .child_pid = pid,
        .allocator = allocator,
    };
}

fn buildExtendedPath(allocator: std.mem.Allocator, home: []const u8, current_path: []const u8) ![:0]u8 {
    return std.fmt.allocPrintSentinel(allocator,
        "{s}/.local/bin:{s}/.npm-global/bin:{s}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:{s}",
        .{ home, home, home, current_path }, 0);
}

fn buildWrappedCommand(allocator: std.mem.Allocator, command: []const u8) ![:0]u8 {
    return std.fmt.allocPrintSentinel(allocator,
        "source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null; {s}",
        .{command},
        0,
    );
}

fn buildLoginArg0(allocator: std.mem.Allocator, shell: []const u8) ![:0]u8 {
    return std.fmt.allocPrintSentinel(allocator, "-{s}", .{std.fs.path.basename(shell)}, 0);
}

extern "c" fn forkpty(
    master: *posix.fd_t,
    name: ?[*:0]u8,
    termp: ?*anyopaque,
    winp: *std.c.winsize,
) posix.pid_t;

extern "c" fn setenv(
    name: [*:0]const u8,
    value: [*:0]const u8,
    overwrite: c_int,
) c_int;

comptime {
    _ = @import("std").c;
}

test "buildExtendedPath keeps inherited PATH while prepending user tool directories" {
    const allocator = std.testing.allocator;
    const path = try buildExtendedPath(allocator, "/Users/edward", "/usr/bin:/bin");
    defer allocator.free(path);

    try std.testing.expectEqualStrings(
        "/Users/edward/.local/bin:/Users/edward/.npm-global/bin:/Users/edward/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        std.mem.sliceTo(path, 0),
    );
}

test "buildWrappedCommand sources shell profiles before running the command" {
    const allocator = std.testing.allocator;
    const wrapped = try buildWrappedCommand(allocator, "echo $FOO");
    defer allocator.free(wrapped);

    try std.testing.expectEqualStrings(
        "source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null; echo $FOO",
        std.mem.sliceTo(wrapped, 0),
    );
}

test "buildLoginArg0 converts the shell basename into a login-shell argv0" {
    const allocator = std.testing.allocator;
    const login_arg0 = try buildLoginArg0(allocator, "/bin/zsh");
    defer allocator.free(login_arg0);

    try std.testing.expectEqualStrings("-zsh", std.mem.sliceTo(login_arg0, 0));
}
