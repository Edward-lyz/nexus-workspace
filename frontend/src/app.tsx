import { useState, useEffect } from 'preact/hooks';
import { Sidebar } from './components/Sidebar';
import { TilingGrid } from './components/TilingGrid';
import { StatusBar } from './components/StatusBar';
import { AgentDialog } from './components/AgentDialog';
import { TaskDialog } from './components/TaskDialog';
import { NoteDialog } from './components/NoteDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ExecutionHistoryDialog } from './components/ExecutionHistoryDialog';
import { ContextMenu, MenuItem } from './components/ContextMenu';
import { NotificationBanner, showNotificationBanner } from './components/NotificationBanner';
import { ExpandedPane } from './components/ExpandedPane';
import { PopoutContainer } from './components/PopoutPane';
import { terminalRegistry } from './components/TerminalPane';
import {
  ipc, hydrateState, markSessionExited, updatePane,
   activeSpace, focusedPaneId, panes, deletePane,
   initializeAgentPool, schedulerSettings, detectPlanMode,
   loadCustomAgents, loadExecutionHistory, popoutPane,
   planModeAlert, expandPane, loadPopoutPositions, currentWorkspaceId, loadSchedulerSettings,
} from './store';
import type { SpaceState } from './store';

type DialogKind = 'agent' | 'task' | 'note' | 'settings' | 'history' | null;

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function App() {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogSpace, setDialogSpace] = useState<SpaceState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  function openDialog(kind: DialogKind) {
    const space = activeSpace.value;
    if (!space) return;
    setDialogSpace(space);
    setDialog(kind);
  }
  function closeDialog() { setDialog(null); setDialogSpace(null); }

  useEffect(() => {
    (async () => {
      await ipc.connect();

      ipc.on('pty.data', (params) => {
        const { session_id, data } = params as { session_id: string; data: string };
        const term = terminalRegistry.get(session_id);
        if (term) {
          const bin = atob(data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          term.write(bytes);
        }
        // Detect plan mode transitions
        const decoded = atob(data);
        detectPlanMode(session_id, decoded);
      });

      ipc.on('pty.exit', (params) => {
        const { session_id } = params as { session_id: string };
        const term = terminalRegistry.get(session_id);
        if (term) term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
        markSessionExited(session_id);
      });

      ipc.on('notification', (params) => {
        const { title, body } = params as { title: string; body: string };
        showNotificationBanner(title, body);
      });

      ipc.on('ai.result', (params) => {
        const { pane_id, description } = params as { pane_id: string; description: string };
        if (pane_id) updatePane(pane_id, { taskDescription: description });
      });

      // Await hydration so the active space is set before initializing the agent pool
      await hydrateState();
      if (currentWorkspaceId.value) {
        await loadSchedulerSettings(currentWorkspaceId.value);
      }
      // Initialize agent pool after space is known
      await initializeAgentPool(schedulerSettings.peek().concurrency);
      loadCustomAgents();
      loadExecutionHistory();
      // Restore popout positions from last session
      loadPopoutPositions();
    })();
  }, []);

  // Watch for plan mode alerts and show notification
  useEffect(() => {
    const alert = planModeAlert.value;
    if (!alert) return;
    showNotificationBanner(
      `${alert.agentName} — Plan Ready`,
      'An agent has generated a plan. Review and approve or request changes.'
    );
    // Focus the pane to make overlay visible
    expandPane(alert.paneId);
  }, [planModeAlert.value]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('.dialog-overlay')) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 't') { e.preventDefault(); openDialog('task'); return; }
      if (meta && e.key === 'k') { e.preventDefault(); openDialog('agent'); return; }
      if (meta && e.key === 'j') { e.preventDefault(); openDialog('note'); return; }
      if (meta && e.key === ',') { e.preventDefault(); setDialog('settings'); return; }
      if (meta && e.key === 'h') { e.preventDefault(); setDialog('history'); return; }
      if (meta && e.key === 'e') {
        e.preventDefault();
        if (focusedPaneId.value) popoutPane(focusedPaneId.value);
        return;
      }
      if (meta && e.key === 'w') {
        e.preventDefault();
        if (focusedPaneId.value) deletePane(focusedPaneId.value);
        return;
      }
      if (meta && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        const all = panes.value;
        if (idx < all.length) focusedPaneId.value = all[idx].id;
        return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Right-click context menu on grid
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Close existing menu first
      setContextMenu(null);

      // Check if right-clicking on grid background (not on a pane)
      const target = e.target as HTMLElement;
      const isOnGrid = target.classList.contains('tiling-grid') || target.classList.contains('grid-cell');
      const isOnPane = target.closest('.pane');

      if (isOnGrid && !isOnPane) {
        e.preventDefault();
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: 'New Task', shortcut: '\u2318T', action: () => openDialog('task') },
            { label: 'New Agent', shortcut: '\u2318K', action: () => openDialog('agent') },
            { label: 'New Note', shortcut: '\u2318J', action: () => openDialog('note') },
          ],
        });
      } else if (isOnPane) {
        e.preventDefault();
        const paneEl = target.closest('.pane') as HTMLElement;
        const paneId = paneEl?.dataset.paneId;
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: 'Copy', shortcut: '\u2318C', action: () => document.execCommand('copy') },
            { label: 'Paste', shortcut: '\u2318V', action: () => document.execCommand('paste') },
            { separator: true },
            { label: 'Close Pane', shortcut: '\u2318W', danger: true, action: () => {
              if (paneId) deletePane(paneId);
              else if (focusedPaneId.value) deletePane(focusedPaneId.value);
            }},
          ],
        });
      }
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  return (
    <>
      <NotificationBanner />
      <div class="app-body">
        <Sidebar
          onAddAgent={(s) => { setDialogSpace(s); setDialog('agent'); }}
          onAddTask={(s) => { setDialogSpace(s); setDialog('task'); }}
          onAddNote={(s) => { setDialogSpace(s); setDialog('note'); }}
        />
        <TilingGrid />
      </div>
      <StatusBar onOpenSettings={() => setDialog('settings')} onOpenHistory={() => setDialog('history')} />
      <PopoutContainer />
      <ExpandedPane />
      {dialog === 'agent' && dialogSpace && <AgentDialog space={dialogSpace} onClose={closeDialog} />}
      {dialog === 'task' && <TaskDialog onClose={closeDialog} />}
      {dialog === 'note' && <NoteDialog onClose={closeDialog} />}
      {dialog === 'settings' && <SettingsDialog onClose={closeDialog} />}
      {dialog === 'history' && <ExecutionHistoryDialog onClose={closeDialog} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
