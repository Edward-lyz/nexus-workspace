import { panes, runningAgentsCount, queuedTasks, schedulerSettings } from '../store';

interface StatusBarProps {
  onOpenSettings: () => void;
  onOpenHistory: () => void;
}

export function StatusBar({ onOpenSettings, onOpenHistory }: StatusBarProps) {
  const allPanes = panes.value;
  const tasks = allPanes.filter(p => p.kind === 'task').length;
  const sessions = allPanes.filter(p => p.kind === 'agent' || p.kind === 'shell').length;
  const running = runningAgentsCount.value;
  const queued = queuedTasks.value.length;
  const autoDispatch = schedulerSettings.value.autoDispatch;

  const parts: string[] = [];
  if (tasks > 0) parts.push(`${tasks} task${tasks > 1 ? 's' : ''}`);
  if (sessions > 0) parts.push(`${sessions} session${sessions > 1 ? 's' : ''}`);
  const summary = parts.length > 0 ? parts.join(' · ') : 'Nexus';

  return (
    <div class="statusbar">
      <div class="statusbar-left">
        <span class="statusbar-summary">{summary}</span>
        {queued > 0 && (
          <span class="statusbar-badge queued" title={`${queued} task${queued > 1 ? 's' : ''} queued`}>
            {queued} queued
          </span>
        )}
        {running > 0 && (
          <span class="statusbar-badge running" title={`${running} agent${running > 1 ? 's' : ''} running`}>
            <span class="statusbar-pulse" />
            {running} running
          </span>
        )}
        <span class={`statusbar-autodispatch ${autoDispatch ? 'on' : 'off'}`} title={autoDispatch ? 'Auto-dispatch ON' : 'Auto-dispatch OFF'}>
          auto {autoDispatch ? 'on' : 'off'}
        </span>
      </div>
      <div class="statusbar-right">
        <button class="statusbar-btn" onClick={onOpenHistory} title="Execution History (Cmd+H)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>
          </svg>
          History
        </button>
        <button class="statusbar-btn settings" onClick={onOpenSettings} title="Settings (Cmd+,)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Settings
        </button>
      </div>
    </div>
  );
}
