# Nexus

<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Nexus Icon">
</p>

<p align="center">
  <b>Tiling workspace for AI coding agents</b><br>
  Zig core + system WebView • Low memory footprint • Multi-agent orchestration
</p>

---

## What it does

- **Auto-tiling terminals** — Grid layout that automatically arranges panes
- **Run any CLI agent** — Claude Code, Codex, Copilot CLI, or any terminal program
- **Spaces** — Organize work into separate spaces, each with its own terminals and tasks
- **Task management** — Create tasks, assign to agents, track progress
- **Persistent workspaces** — Layout and state survive app restarts (SQLite-backed)
- **Lightweight** — ~3MB binary, ~30-50MB RAM (vs Electron's 200-300MB)
- **macOS native** — System WebView, native menus, Cmd+Q/C/V/X/A support

## Screenshots

<!-- TODO: Add screenshots -->

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Zig Daemon                                                 │
│  • PTY pool (forkpty)                                       │
│  • Session lifecycle management                             │
│  • SQLite persistence (~/.cove/cove.db)                     │
│  • HTTP static server + WebSocket JSON-RPC                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket
┌──────────────────────────┴──────────────────────────────────┐
│  System WebView                                             │
│  • Preact + Signals (reactive state)                        │
│  • xterm.js (terminal emulation)                            │
│  • CSS Grid (auto-tiling layout)                            │
│  • Glassmorphism UI                                         │
└─────────────────────────────────────────────────────────────┘
```

## Build

**Requirements:** Zig 0.15+, Node.js 20+

```bash
# Build frontend
cd frontend && npm install && npm run build && cd ..

# Run development
zig build run

# Build release
zig build -Doptimize=ReleaseFast
```

## Testing

```bash
# Frontend functional/unit coverage
npm --prefix frontend run test:run

# Backend Zig coverage
zig build test

# Run both test suites
./tests/run-functional-tests.sh
```

### Package as macOS App

```bash
# Build release binary
zig build -Doptimize=ReleaseFast

# Create app bundle structure
mkdir -p Nexus.app/Contents/{MacOS,Resources}
cp zig-out/bin/cove Nexus.app/Contents/MacOS/nexus
cp -r frontend/dist/* Nexus.app/Contents/Resources/static/

# Sign for local use
xattr -cr Nexus.app && codesign --force --deep --sign - Nexus.app

# Run
open Nexus.app
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Cmd+T | New task |
| Cmd+K | New agent |
| Cmd+J | New note |
| Cmd+W | Close focused pane |
| Cmd+1..9 | Focus pane by index |
| Cmd+C/V/X | Copy/Paste/Cut |
| Cmd+A | Select all |
| Cmd+Z | Undo |
| Cmd+Q | Quit |

## Project Structure

```
├── src/
│   ├── main.zig      # Entry point, WebView setup
│   ├── ipc.zig       # WebSocket JSON-RPC server
│   ├── pty.zig       # PTY spawning and management
│   ├── session.zig   # Session lifecycle
│   ├── db.zig        # SQLite persistence
│   ├── macos.zig     # macOS native features (menus, dialogs)
│   └── notify.zig    # System notifications
├── frontend/
│   ├── src/
│   │   ├── app.tsx           # Main app component
│   │   ├── store.ts          # State management (Signals)
│   │   ├── ipc.ts            # WebSocket client
│   │   ├── components/       # UI components
│   │   └── theme/            # CSS tokens and styles
│   └── package.json
├── build.zig
└── README.md
```

## Inspiration

Inspired by [OpenCove](https://github.com/nicepkg/opencove) — rebuilt from scratch for lower resource usage and better multi-agent support.

## License

MIT. See [LICENSE](LICENSE).
