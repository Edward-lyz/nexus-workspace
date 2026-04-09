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
            const resolved_dir = resolveWorkingDirectory(allocator, dir) catch dir;
            defer if (resolved_dir.ptr != dir.ptr) allocator.free(resolved_dir);
            std.posix.chdir(resolved_dir) catch {};
        }

        // Set environment variables - these modify the process environment
        _ = setenv("TERM", "xterm-256color", 1);

        // Ensure common user bin paths are in PATH for macOS app bundles
        const current_path = std.posix.getenv("PATH") orelse "/usr/bin:/bin";
        const home = std.posix.getenv("HOME") orelse "";
        const extended_path = std.fmt.allocPrintSentinel(allocator,
            "{s}/.local/bin:{s}/.npm-global/bin:{s}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:{s}",
            .{ home, home, home, current_path }, 0) catch current_path;
        _ = setenv("PATH", extended_path, 1);

        // Source user profile to get additional env vars (ANTHROPIC_API_KEY, etc.)
        // Use login shell which sources .zprofile/.bash_profile
        if (command) |cmd| {
            // Wrap command in login shell to get full environment
            const shell = std.posix.getenv("SHELL") orelse "/bin/zsh";
            const wrapped_cmd = std.fmt.allocPrintSentinel(allocator,
                "exec {s}",
                .{cmd}, 0) catch {
                std.posix.exit(1);
            };
            const argv = [_:null]?[*:0]const u8{
                @ptrCast(shell),
                "-il".ptr,
                "-c".ptr,
                wrapped_cmd.ptr,
                null,
            };
            // Use current environ which now includes our setenv changes
            const envp = @as([*:null]const ?[*:0]const u8, @ptrCast(std.c.environ));
            std.posix.execvpeZ(@ptrCast(shell), &argv, envp) catch {};
        } else {
            const shell = std.posix.getenv("SHELL") orelse "/bin/zsh";
            const shell_basename = std.fs.path.basename(shell);
            const login_name = std.fmt.allocPrintSentinel(allocator, "-{s}", .{shell_basename}, 0) catch {
                std.posix.exit(1);
            };

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

fn resolveWorkingDirectory(allocator: std.mem.Allocator, dir: []const u8) ![]const u8 {
    if (dir.len == 0 or dir[0] != '~') {
        return dir;
    }

    const home = std.posix.getenv("HOME") orelse return dir;
    if (std.mem.eql(u8, dir, "~")) {
        return allocator.dupe(u8, home);
    }
    if (dir.len > 1 and dir[1] == '/') {
        return std.fmt.allocPrint(allocator, "{s}{s}", .{ home, dir[1..] });
    }
    return dir;
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
