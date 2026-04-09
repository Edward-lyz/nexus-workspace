import { useRef, useEffect, useState } from 'preact/hooks';
import { tasks, ipc, updatePane, panes } from '../store';
import type { TaskEntity } from '../store';

interface Props {
  taskId: string;
  onClose: () => void;
}

export function TaskEditDialog({ taskId, onClose }: Props) {
  const task = tasks.value.get(taskId);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>(task?.priority ?? 'medium');
  const [status, setStatus] = useState<'todo' | 'doing' | 'done'>(task?.status ?? 'todo');

  useEffect(() => { titleRef.current?.focus(); }, []);

  if (!task) {
    onClose();
    return null;
  }

  const submit = async () => {
    const title = titleRef.current?.value.trim() || task.title;
    const description = descRef.current?.value.trim() || task.description;

    try {
      await ipc.call('task.update', {
        id: taskId,
        title,
        description,
        priority,
        status,
      });

      // Update local state
      const updated: TaskEntity = { ...task, title, description, priority, status };
      tasks.value = new Map(tasks.value).set(taskId, updated);

      // Also update pane if exists
      updatePane(taskId, {
        taskTitle: title,
        taskDescription: description,
        taskPriority: priority,
        taskStatus: status,
      });

      onClose();
    } catch (err) {
      console.error('task.update failed:', err);
    }
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog dialog-wide">
        <div class="dialog-header">Edit Task</div>

        <label class="dialog-label">Title</label>
        <input
          ref={titleRef}
          class="dialog-input"
          defaultValue={task.title}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) submit(); }}
        />

        <label class="dialog-label">Description</label>
        <textarea
          ref={descRef}
          class="dialog-textarea"
          defaultValue={task.description}
          rows={6}
        />

        <label class="dialog-label">Priority</label>
        <div class="dialog-agents">
          {(['low', 'medium', 'high'] as const).map(p => (
            <label key={p} class="agent-radio">
              <input type="radio" name="priority" checked={priority === p} onChange={() => setPriority(p)} />
              <span class="agent-chip" style={`--agent-color:${p === 'high' ? 'var(--cove-error)' : p === 'medium' ? 'var(--cove-warning)' : 'var(--cove-text-muted)'}`}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </span>
            </label>
          ))}
        </div>

        <label class="dialog-label">Status</label>
        <div class="dialog-agents">
          {(['todo', 'doing', 'done'] as const).map(s => (
            <label key={s} class="agent-radio">
              <input type="radio" name="status" checked={status === s} onChange={() => setStatus(s)} />
              <span class="agent-chip" style={`--agent-color:${s === 'done' ? 'var(--cove-success)' : s === 'doing' ? 'var(--cove-warning)' : 'var(--cove-text-muted)'}`}>
                {s === 'todo' ? 'To Do' : s === 'doing' ? 'In Progress' : 'Done'}
              </span>
            </label>
          ))}
        </div>

        <div class="dialog-actions">
          <button class="dialog-cancel" onClick={onClose}>Cancel</button>
          <button class="dialog-submit" onClick={submit}>Save</button>
        </div>
        <div class="dialog-hint">Cmd+Enter to save</div>
      </div>
    </div>
  );
}
