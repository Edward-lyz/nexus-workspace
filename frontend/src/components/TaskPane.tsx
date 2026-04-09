import { useState } from 'preact/hooks';
import {
  focusedPaneId, focusPane, deletePane, updatePane, getLinkedPane,
  spawnAgentForTask, spawnShellForTask, BUILTIN_AGENTS, exportTaskContext, cloneTaskToAgent,
  expandPane, getAgentForTask, tasks, getSubtasks, getTaskAncestors,
  type TaskEntity,
} from '../store';
import { TerminalPane, terminalRegistry } from './TerminalPane';
import type { PaneState } from '../store';

const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do', doing: 'In Progress', done: 'Done',
};
const STATUS_COLORS: Record<string, string> = {
  todo: 'var(--cove-text-faint)', doing: 'var(--cove-warning)', done: 'var(--cove-success)',
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
  const linked = getLinkedPane(pane.id);
  const assignedAgent = getAgentForTask(pane.id);
  const taskEntity = tasks.value.get(pane.id);
  const subtasks = getSubtasks(pane.id);
  const ancestors = getTaskAncestors(pane.id);
  const [showDispatch, setShowDispatch] = useState(false);
  const [showClone, setShowClone] = useState(false);

  const statusKey = pane.taskStatus ?? 'todo';
  const nextStatus = statusKey === 'todo' ? 'doing' : statusKey === 'doing' ? 'done' : 'todo';

  const handleExportContext = async () => {
    const context = await exportTaskContext(pane.id, terminalRegistry);
    await navigator.clipboard.writeText(context);
    // Could show a toast here
  };

  const handleCloneToAgent = async (agentId: string) => {
    await cloneTaskToAgent(pane.id, agentId, terminalRegistry);
    setShowClone(false);
  };

  return (
    <div class={`pane task-pane ${isFocused ? 'focused' : ''}`} data-pane-id={pane.id} onMouseDown={() => focusPane(pane.id)}>
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
          <button class="btn-expand" onClick={(e) => { e.stopPropagation(); expandPane(pane.id); }} title="Expand panel">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
          <button class="btn-close" onClick={(e) => { e.stopPropagation(); deletePane(pane.id); }}>x</button>
        </span>
      </div>

      <div class="task-meta">
        <div class="task-title" onDblClick={() => onEdit?.(pane.id)}>{pane.taskTitle}</div>
        {pane.taskDescription && <div class="task-desc">{pane.taskDescription}</div>}

        {/* Show subtasks count if any */}
        {subtasks.length > 0 && (
          <div class="task-subtasks-badge">{subtasks.length} subtask{subtasks.length > 1 ? 's' : ''}</div>
        )}

        {/* Show breadcrumb if this is a subtask */}
        {ancestors.length > 0 && (
          <div class="task-breadcrumb">
            {ancestors.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ' > '}
                <span class="breadcrumb-item">{a.title}</span>
              </span>
            ))}
          </div>
        )}

        {!linked && (
          <div class="task-actions">
            {!showDispatch ? (
              <button class="task-dispatch-btn" onClick={() => setShowDispatch(true)}>
                Dispatch to Agent...
              </button>
            ) : (
              <div class="task-dispatch-options">
                {BUILTIN_AGENTS.map(a => (
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
            <span class="task-link-id">{linked.sessionId}</span>
            {linked.sessionStatus === 'exited' && <span class="task-link-status">ended</span>}
            {assignedAgent && (
              <span class="task-slot-badge" title={`Assigned to ${assignedAgent.slotId}`}>
                {assignedAgent.slotId.replace('slot-', '#')}
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
                {BUILTIN_AGENTS.filter(a => a.id !== (BUILTIN_AGENTS.find(x => x.name === linked.agentName)?.id)).map(a => (
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
