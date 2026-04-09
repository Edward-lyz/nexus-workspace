import { useState } from 'preact/hooks';
import {
  focusedPaneId, focusPane, deletePane, archivePane, updatePane, getLinkedPane,
  spawnAgentForTask, spawnShellForTask, exportTaskContext, cloneTaskToAgent,
  expandPane, getAgentForTask,
  expandedPaneId, popoutPanes, popoutPane, closePopout, spawnBestOfN, allAgents,
  shakeOncePaneId,
} from '../store';
import { TerminalPane, terminalRegistry } from './TerminalPane';
import { showNotificationBanner } from './NotificationBanner';
import type { PaneState } from '../store';

const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do', doing: 'In Progress', done: 'Done',
};
const STATUS_COLORS: Record<string, string> = {
  todo: 'var(--nx-text-tertiary)', doing: 'var(--nx-warning)', done: 'var(--nx-success)',
};
const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low', medium: 'Med', high: 'High',
};

interface Props {
  pane: PaneState;
  onEdit?: (taskId: string) => void;
}

export function TaskPane({ pane, onEdit }: Props) {
  const isFocused = focusedPaneId.value === pane.id;
  const isExpanded = expandedPaneId.value === pane.id;
  const isPopped = popoutPanes.value.has(pane.id);
  const shouldShake = shakeOncePaneId.value === pane.id;
  const linked = getLinkedPane(pane.id);
  const assignedAgent = getAgentForTask(pane.id);
  const [showDispatch, setShowDispatch] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [showBestOfN, setShowBestOfN] = useState(false);
  const [bestOfNCount, setBestOfNCount] = useState(3);

  const statusKey = pane.taskStatus ?? 'todo';
  const nextStatus = statusKey === 'todo' ? 'doing' : statusKey === 'doing' ? 'done' : 'todo';
  const taskLine = pane.taskDescription?.trim() || pane.taskTitle?.trim() || 'Untitled task';

  const copyContext = async (text: string): Promise<boolean> => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  };

  const downloadContext = (text: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(pane.taskTitle ?? 'task').replace(/[^\w.-]+/g, '-').toLowerCase() || 'task'}-context.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportContext = async () => {
    const context = await exportTaskContext(pane.id, terminalRegistry);
    if (await copyContext(context)) {
      showNotificationBanner('Context exported', 'Task context copied to clipboard.');
      return;
    }

    downloadContext(context);
    showNotificationBanner('Context exported', 'Clipboard unavailable, downloaded as a text file.');
  };

  const handleCloneToAgent = async (agentId: string) => {
    await cloneTaskToAgent(pane.id, agentId, terminalRegistry);
    setShowClone(false);
  };

  const handleBestOfN = async () => {
    const prompt = pane.taskDescription ?? pane.taskTitle ?? '';
    const agentIds = allAgents.value.slice(0, bestOfNCount).map(a => a.id);
    await spawnBestOfN(pane.id, agentIds, prompt);
    setShowBestOfN(false);
  };

  return (
    <div class={`pane task-pane ${isFocused ? 'focused' : ''} ${pane.needsAttention ? 'needs-attention' : ''} ${shouldShake ? 'shake-once' : ''}`} data-pane-id={pane.id} onMouseDown={() => focusPane(pane.id)}>
      <div class="pane-header">
        <span class="pane-title">
          <span class="pane-badge task">Task</span>
          <span class="pane-badge priority" data-priority={pane.taskPriority ?? 'medium'}>
            {PRIORITY_LABELS[pane.taskPriority ?? 'medium']}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            class="status-toggle"
            style={{ color: STATUS_COLORS[statusKey] }}
            onClick={() => updatePane(pane.id, { taskStatus: nextStatus as PaneState['taskStatus'] })}
            title={`Click to mark as ${STATUS_LABELS[nextStatus]}`}
          >{STATUS_LABELS[statusKey]}</button>
          <button class="btn-edit" onClick={(e) => { e.stopPropagation(); onEdit?.(pane.id); }} title="Edit task">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
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
            class="btn-edit"
            onClick={(e) => { e.stopPropagation(); archivePane(pane.id); }}
            title="Archive task"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
            </svg>
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
          <button class="btn-close" onClick={(e) => { e.stopPropagation(); void deletePane(pane.id); }}>x</button>
        </span>
      </div>

      <div class="task-meta">
        <div class="task-line" title={taskLine} onDblClick={() => onEdit?.(pane.id)}>{taskLine}</div>

        {!linked && (
          <div class="task-actions">
            {showBestOfN ? (
              <div class="best-of-n-panel">
                <div class="best-of-n-row">
                  <span class="best-of-n-label">Run</span>
                  <select
                    class="best-of-n-select"
                    value={bestOfNCount}
                    onChange={(e) => setBestOfNCount(parseInt((e.target as HTMLSelectElement).value))}
                  >
                    {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n} agents</option>)}
                  </select>
                  <span class="best-of-n-label">in parallel</span>
                </div>
                <div class="best-of-n-agents">
                  {allAgents.value.slice(0, bestOfNCount).map(a => (
                    <span key={a.id} class="task-agent-chip-sm" style={`--agent-color:${a.color}`}>{a.name}</span>
                  ))}
                </div>
                <div class="best-of-n-actions">
                  <button class="task-dispatch-btn primary" onClick={handleBestOfN}>Run Best of {bestOfNCount}</button>
                  <button class="task-dispatch-btn" onClick={() => setShowBestOfN(false)}>Cancel</button>
                </div>
              </div>
            ) : !showDispatch ? (
              <div class="task-actions-row">
                <button class="task-dispatch-btn" onClick={() => setShowDispatch(true)}>
                  Dispatch to Agent...
                </button>
                <button class="task-dispatch-btn secondary" onClick={() => setShowBestOfN(true)} title="Run with multiple agents and compare">
                  Best of N
                </button>
              </div>
            ) : (
              <div class="task-dispatch-options">
                {allAgents.value.map(a => (
                  <button
                    key={a.id}
                    class="task-agent-chip"
                    style={`--agent-color:${a.color}`}
                    onClick={() => {
                      spawnAgentForTask(pane.id, a.id, pane.taskDescription ?? pane.taskTitle ?? '');
                      setShowDispatch(false);
                    }}
                  >{a.name}</button>
                ))}
                <button
                  class="task-agent-chip shell-chip"
                  onClick={() => { spawnShellForTask(pane.id); setShowDispatch(false); }}
                >Shell</button>
              </div>
            )}
          </div>
        )}

        {linked && (
          <div class="task-agent-bar">
            <span class={`sidebar-badge ${linked.kind}`}>
              {linked.kind === 'agent' ? (linked.agentName ?? 'Agent') : 'Shell'}
            </span>
            <span class="task-link-id">{linked.sessionId ?? 'pending'}</span>
            {linked.sessionStatus === 'pending' && <span class="task-link-status">pending</span>}
            {linked.sessionStatus === 'idle' && <span class="task-link-status">idle</span>}
            {linked.sessionStatus === 'exited' && <span class="task-link-status">ended</span>}
            {assignedAgent && (
              <span class="task-slot-badge" title={`Assigned to ${assignedAgent.id}`}>
                {assignedAgent.id.replace('slot-', '#')}
              </span>
            )}
          </div>
        )}

        {/* Context migration actions */}
        {linked && linked.sessionId && (
          <div class="task-context-actions">
            <button class="task-context-btn" onClick={handleExportContext} title="Copy context to clipboard">
              Export Context
            </button>
            {!showClone ? (
              <button class="task-context-btn" onClick={() => setShowClone(true)}>
                Clone to...
              </button>
            ) : (
              <div class="task-clone-options">
                {allAgents.value.filter(a => a.name !== linked.agentName).map(a => (
                  <button
                    key={a.id}
                    class="task-agent-chip"
                    style={`--agent-color:${a.color}`}
                    onClick={() => handleCloneToAgent(a.id)}
                  >{a.name}</button>
                ))}
                <button class="task-context-btn cancel" onClick={() => setShowClone(false)}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Inline terminal — fills remaining space when agent/shell is linked */}
      {linked && linked.sessionId && (
        <div class="task-terminal">
          <TerminalPane pane={linked} />
        </div>
      )}
    </div>
  );
}
