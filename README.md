# Nexus

<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Nexus Icon">
</p>

<p align="center">
  <b>Tiling workspace for AI coding agents</b><br>
  <b>AI 编程代理的平铺式工作空间</b><br>
  Zig daemon + React frontend • Low memory footprint • Multi-agent orchestration
</p>

<p align="center">
  <a href="#what-it-does">English</a> | <a href="#功能特性">中文</a>
</p>

---

## What it does

- **Auto-tiling terminals** — Grid layout that automatically arranges panes
- **Run any CLI agent** — Claude Code, Codex, Copilot CLI, or any terminal program
- **Spaces** — Organize work into separate spaces, each with its own terminals and tasks
- **Task management** — Kanban board with 5 status columns, drag-and-drop support
- **Persistent workspaces** — Layout and state survive restarts (SQLite-backed)
- **Lightweight** — ~2MB binary, ~30-50MB RAM (vs Electron's 200-300MB)
- **Browser-based** — Opens in your default browser, no app window needed

## Installation

### From source

```bash
# Clone
git clone https://github.com/user/nexus.git && cd nexus

# Install submodules
git submodule update --init --recursive

# Build frontend
cd frontend-v2 && bun install && bun run build && cd ..

# Build & run daemon
zig build run
```

The daemon will start on a random port and automatically open your browser.

### Requirements

- Zig 0.15.2+
- Bun or Node.js 20+

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Zig Daemon                                                 │
│  • PTY pool (forkpty)                                       │
│  • Session lifecycle management                             │
│  • SQLite persistence (~/.nexus/default.nexus.db)           │
│  • HTTP static server + WebSocket JSON-RPC                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP + WebSocket
┌──────────────────────────┴──────────────────────────────────┐
│  Browser (React 19 + TypeScript)                            │
│  • TanStack Query (server state)                            │
│  • Zustand (client state)                                   │
│  • ghostty-web (terminal emulation)                         │
│  • Tailwind CSS v4 + shadcn/ui                              │
└─────────────────────────────────────────────────────────────┘
```

## Build

```bash
# Build frontend
cd frontend-v2 && bun run build && cd ..

# Run daemon (opens browser automatically)
zig build run

# Build release binary
zig build -Doptimize=ReleaseFast
```

## Testing

```bash
# Backend Zig tests
zig build test
```

## Project Structure

```
├── src/
│   ├── main.zig      # Daemon entry point, signal handling, browser open
│   ├── ipc.zig       # HTTP static server + WebSocket JSON-RPC
│   ├── pty.zig       # PTY spawning and management
│   ├── session.zig   # Session lifecycle
│   ├── db.zig        # SQLite persistence
│   ├── macos.zig     # macOS native folder picker
│   └── notify.zig    # System notifications
├── frontend-v2/       # React frontend
│   ├── src/
│   │   ├── app/       # Router, layout, providers
│   │   ├── features/  # Tasks, agents, terminal, chat, settings
│   │   ├── components/ui/  # shadcn/ui components
│   │   ├── rpc/       # WebSocket client, hooks, mutations, queries
│   │   └── stores/    # Zustand stores
│   └── package.json
├── ghostty-web/       # Terminal emulation (submodule)
├── build.zig
└── README.md
```

## License

MIT. See [LICENSE](LICENSE).

---

# 中文文档

## 功能特性

- **自动平铺终端** — 网格布局自动排列窗格
- **运行任意 CLI 代理** — Claude Code、Codex、Copilot CLI 或任何终端程序
- **工作空间** — 将工作组织到独立空间，每个空间有自己的终端和任务
- **任务管理** — 5 列看板视图，支持拖拽
- **持久化工作空间** — 布局和状态在重启后保留（SQLite 存储）
- **轻量级** — 约 2MB 二进制文件，约 30-50MB 内存（对比 Electron 的 200-300MB）
- **浏览器运行** — 自动在浏览器中打开，无需应用窗口

## 安装

### 从源码构建

```bash
# 克隆
git clone https://github.com/user/nexus.git && cd nexus

# 初始化子模块
git submodule update --init --recursive

# 构建前端
cd frontend-v2 && bun install && bun run build && cd ..

# 构建并运行守护进程
zig build run
```

守护进程会在随机端口启动并自动打开浏览器。

### 依赖

- Zig 0.15.2+
- Bun 或 Node.js 20+

## 许可证

MIT. 见 [LICENSE](LICENSE)。
