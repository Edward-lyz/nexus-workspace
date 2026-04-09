import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { ipc, focusedPaneId, focusPane, deletePane, BUILTIN_AGENTS, cloneAgentToAgent, expandPane, popoutPane, detectPlanMode } from '../store';
import { PlanModeOverlay } from './PlanModeOverlay';
import type { PaneState } from '../store';


const TERMINAL_THEME = {
  // Nexus "Deep Ocean" terminal palette
  background: '#080b0f',
  foreground: '#e2e8f0',
  cursor: '#22d3ee',
  cursorAccent: '#080b0f',
  selectionBackground: 'rgba(34, 211, 238, 0.25)',
  selectionForeground: '#ffffff',
  // ANSI colors - balanced vibrancy
  black: '#334155',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
};

// Global registry so PTY data handler can find terminals by sessionId
export const terminalRegistry = new Map<string, Terminal>();

interface Props {
  pane: PaneState;
}

export function TerminalPane({ pane }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [showClone, setShowClone] = useState(false);

  const isFocused = focusedPaneId.value === pane.id;

  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;

    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: "'Geist Mono', 'SF Mono', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      letterSpacing: 0,
    });

    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    terminal.open(container);

    termRef.current = terminal;
    fitRef.current = fitAddon;
    terminalRegistry.set(pane.sessionId, terminal);

    requestAnimationFrame(() => fitAddon.fit());

    terminal.onData((data) => {
      ipc.call('pty.write', { session_id: pane.sessionId, data });
    });

    terminal.onResize(({ cols, rows }) => {
      ipc.call('pty.resize', { session_id: pane.sessionId, cols, rows });
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      terminalRegistry.delete(pane.sessionId);
      terminal.dispose();
    };
  }, [pane.sessionId]);

  useEffect(() => {
    if (isFocused && termRef.current) {
      termRef.current.focus();
    }
  }, [isFocused]);

  const badgeClass = pane.kind === 'agent' ? 'pane-badge agent' : 'pane-badge shell';
  const badgeLabel = pane.kind === 'agent' ? (pane.agentName ?? 'Agent') : 'Shell';
  const dotClass = pane.sessionStatus === 'exited' ? 'status-dot exited' : 'status-dot';
  const currentAgentId = BUILTIN_AGENTS.find(a => a.name === pane.agentName)?.id;

  const handleClone = async (targetAgentId: string) => {
    await cloneAgentToAgent(pane.id, targetAgentId, terminalRegistry);
    setShowClone(false);
  };

  return (
    <div
      class={`pane ${isFocused ? 'focused' : ''}`}
      data-pane-id={pane.id}
      onMouseDown={() => focusPane(pane.id)}
    >
      <div class="pane-header">
        <span class="pane-title">
          <span class={badgeClass}>{badgeLabel}</span>
          <span class="pane-sid">{pane.sessionId}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {pane.kind === 'agent' && !pane.embedded && (
            !showClone ? (
              <button class="btn-clone" onClick={() => setShowClone(true)} title="Clone to another agent">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            ) : (
              <div class="clone-options">
                {BUILTIN_AGENTS.filter(a => a.id !== currentAgentId).map(a => (
                  <button key={a.id} class="clone-chip" style={`--agent-color:${a.color}`} onClick={() => handleClone(a.id)}>
                    {a.name}
                  </button>
                ))}
                <button class="clone-cancel" onClick={() => setShowClone(false)}>x</button>
              </div>
            )
          )}
          {!pane.embedded && (
            <>
              <button class="btn-popout" onClick={(e) => { e.stopPropagation(); popoutPane(pane.id); }} title="Pop out to window">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </button>
              <button class="btn-expand" onClick={(e) => { e.stopPropagation(); expandPane(pane.id); }} title="Expand panel">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
              </button>
            </>
          )}
          <span class={dotClass} />
          <button
            class="btn-close"
            onClick={(e) => { e.stopPropagation(); deletePane(pane.id); }}
          >
            x
          </button>
        </span>
      </div>
      <div class="pane-body" ref={bodyRef} />
      {pane.planMode && <PlanModeOverlay pane={pane} />}
    </div>
  );
}
