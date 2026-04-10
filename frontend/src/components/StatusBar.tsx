import { tasks, activeSessionsCount, queuedTasks, schedulerSettings, activeSpaceId } from '../store';

export function StatusBar() {
  const activeId = activeSpaceId.value;
  const taskCount = [...tasks.value.values()].filter(t => t.spaceId === activeId).length;
  const sessions = activeSessionsCount.value;
  const queued = queuedTasks.value.length;
  const autoDispatch = schedulerSettings.value.autoDispatch;

  const parts: string[] = [];
  if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? 's' : ''}`);
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
        {sessions > 0 && (
          <span class="statusbar-badge running" title={`${sessions} session${sessions > 1 ? 's' : ''} running`}>
            <span class="statusbar-pulse" />
            {sessions} running
          </span>
        )}
        <span class={`statusbar-autodispatch ${autoDispatch ? 'on' : 'off'}`} title={autoDispatch ? 'Auto-dispatch ON' : 'Auto-dispatch OFF'}>
          auto {autoDispatch ? 'on' : 'off'}
        </span>
      </div>
    </div>
  );
}
