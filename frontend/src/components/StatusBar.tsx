import { panes } from '../store';

export function StatusBar() {
  const allPanes = panes.value;
  const tasks = allPanes.filter(p => p.kind === 'task').length;
  const agents = allPanes.filter(p => p.kind === 'agent' || p.kind === 'shell').length;

  const parts: string[] = [];
  if (tasks > 0) parts.push(`${tasks} task${tasks > 1 ? 's' : ''}`);
  if (agents > 0) parts.push(`${agents} session${agents > 1 ? 's' : ''}`);
  const summary = parts.length > 0 ? parts.join(' \u00b7 ') : 'Nexus';

  return (
    <div class="statusbar">
      <div class="statusbar-left">
        <span>{summary}</span>
      </div>
    </div>
  );
}
