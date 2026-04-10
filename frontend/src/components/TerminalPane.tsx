import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { ipc, focusedPaneId, focusPane, deletePane, archivePane, BUILTIN_AGENTS, cloneAgentToAgent, expandPane, popoutPane, expandedPaneId, popoutPanes, closePopout, markSessionActivity, shakeOncePaneId } from '../store';
import { PlanModeOverlay } from './PlanModeOverlay';
import type { PaneState } from '../store';


// One Dark theme
const THEME_ONE_DARK = {
  background: '#282c34',
  foreground: '#abb2bf',
  cursor: '#528bff',
  cursorAccent: '#282c34',
  selectionBackground: 'rgba(82, 139, 255, 0.3)',
  selectionForeground: '#ffffff',
  black: '#3f4451',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

// One Light theme
const THEME_ONE_LIGHT = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526fff',
  cursorAccent: '#fafafa',
  selectionBackground: 'rgba(82, 111, 255, 0.2)',
  selectionForeground: '#000000',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#696c77',
  brightRed: '#e45649',
  brightGreen: '#50a14f',
  brightYellow: '#c18401',
  brightBlue: '#4078f2',
  brightMagenta: '#a626a4',
  brightCyan: '#0184bc',
  brightWhite: '#fafafa',
};

function getTerminalTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return isDark ? THEME_ONE_DARK : THEME_ONE_LIGHT;
}

// Global registry so PTY data handler can find terminals by sessionId
export const terminalRegistry = new Map<string, Terminal>();
const terminalSnapshotRegistry = new Map<string, string>();

interface Props {
  pane: PaneState;
}

export function TerminalPane({ pane }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<{ sessionId?: string; active: boolean }>({
    sessionId: pane.sessionId,
    active: Boolean(pane.sessionId) && pane.sessionStatus !== 'exited',
  });
  const [showClone, setShowClone] = useState(false);

  const isFocused = focusedPaneId.value === pane.id;
  const isExpanded = expandedPaneId.value === pane.id;
  const isPopped = popoutPanes.value.has(pane.id);
  const shouldShake = shakeOncePaneId.value === pane.id;

  useEffect(() => {
    sessionRef.current = {
      sessionId: pane.sessionId,
      active: Boolean(pane.sessionId) && pane.sessionStatus !== 'exited',
    };
  }, [pane.sessionId, pane.sessionStatus]);

  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;

    const terminal = new Terminal({
      theme: getTerminalTheme(),
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
    if (pane.sessionId) {
      terminalRegistry.set(pane.sessionId, terminal);
    }

    const snapshot = pane.sessionId ? terminalSnapshotRegistry.get(pane.sessionId) : undefined;
    if (snapshot) {
      terminal.write(snapshot);
    } else {
      void ipc.call<string | null>('scrollback.load', { node_id: pane.id }).then((saved) => {
        if (saved) {
          terminal.write(saved);
        }
      }).catch(() => {});
    }

    requestAnimationFrame(() => fitAddon.fit());

    terminal.onData((data) => {
      if (!sessionRef.current.active || !sessionRef.current.sessionId) return;
      markSessionActivity(sessionRef.current.sessionId);
      void ipc.call('pty.write', { session_id: sessionRef.current.sessionId, data }).catch(() => {});
    });

    terminal.onResize(({ cols, rows }) => {
      if (!sessionRef.current.active || !sessionRef.current.sessionId) return;
      void ipc.call('pty.resize', { session_id: sessionRef.current.sessionId, cols, rows }).catch(() => {});
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });
    resizeObserver.observe(container);

    // Listen for theme changes and update terminal
    const themeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'data-theme') {
          terminal.options.theme = getTerminalTheme();
        }
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      if (pane.sessionId) {
        terminalSnapshotRegistry.set(pane.sessionId, serializeAddon.serialize());
        terminalRegistry.delete(pane.sessionId);
      }
      terminal.dispose();
    };
  }, [pane.sessionId]);

  useEffect(() => {
    // Only steal focus when transitioning to focused state, not on every re-render
    // while already focused. This prevents agent output updates from re-triggering focus.
    if (isFocused && termRef.current) {
      const activeEl = document.activeElement;
      const termEl = bodyRef.current;
      if (termEl && !termEl.contains(activeEl)) {
        termRef.current.focus();
      }
    }
  }, [isFocused]);

  const badgeClass = pane.kind === 'agent' ? 'pane-badge agent' : 'pane-badge shell';
  const badgeLabel = pane.kind === 'agent' ? (pane.agentName ?? 'Agent') : 'Shell';
  const dotClass = `status-dot ${pane.sessionStatus ?? 'idle'}`;
  const currentAgentId = BUILTIN_AGENTS.find(a => a.name === pane.agentName)?.id;

  const handleClone = async (targetAgentId: string) => {
    await cloneAgentToAgent(pane.id, targetAgentId, terminalRegistry);
    setShowClone(false);
  };

  return (
      <div
      class={`pane ${isFocused ? 'focused' : ''} ${pane.needsAttention ? 'needs-attention' : ''} ${shouldShake ? 'shake-once' : ''}`}
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
              <button
                class={`btn-popout ${isPopped ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isPopped) closePopout(pane.id);
                  else popoutPane(pane.id);
                }}
                title={isPopped ? 'Restore to grid' : 'Pop out to window'}
              >
                {isPopped ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                )}
              </button>
              <button
                class={`btn-expand ${isExpanded ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  expandPane(isExpanded ? null : pane.id);
                }}
                title={isExpanded ? 'Collapse panel' : 'Expand panel'}
              >
                {isExpanded ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                  </svg>
                )}
              </button>
            </>
          )}
          <span class={dotClass} />
          <button
            class="btn-clone"
            onClick={(e) => { e.stopPropagation(); archivePane(pane.id); }}
            title="Archive session"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
            </svg>
          </button>
          <button
            class="btn-close"
            onClick={(e) => { e.stopPropagation(); void deletePane(pane.id); }}
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
