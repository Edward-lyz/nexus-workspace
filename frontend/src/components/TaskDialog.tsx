import { useRef, useEffect, useState } from 'preact/hooks';
import { createTask, ipc } from '../store';

interface Props {
  onClose: () => void;
}

export function TaskDialog({ onClose }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');

  useEffect(() => { titleRef.current?.focus(); }, []);

  const submit = () => {
    const title = titleRef.current?.value.trim();
    if (!title) return;

    const pane = createTask(title, '...', priority);
    onClose();

    if (pane) {
      // Fire-and-forget — result comes back via ai.result broadcast in app.tsx
      ipc.call('ai.summarize', {
        prompt: title,
        pane_id: pane.id,
      }).catch(() => {});
    }
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog">
        <div class="dialog-header">New Task</div>
        <label class="dialog-label">What needs to be done?</label>
        <input
          ref={titleRef}
          class="dialog-input"
          placeholder="e.g., Fix login bug, Add dark mode..."
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
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
        <div class="dialog-actions">
          <button class="dialog-cancel" onClick={onClose}>Cancel</button>
          <button class="dialog-submit" onClick={submit}>Create</button>
        </div>
        <div class="dialog-hint">AI will fill description in background</div>
      </div>
    </div>
  );
}
