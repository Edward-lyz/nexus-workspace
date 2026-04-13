import { useRef, useEffect, useState } from 'preact/hooks';
import { createTask } from '../store';

interface Props {
  onClose: () => void;
}

export function TaskDialog({ onClose }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const submit = async () => {
    const prompt = titleRef.current?.value.trim();
    if (!prompt || submitting) return;

    setSubmitting(true);
    setError(null);
    const task = await createTask(prompt, prompt, priority);
    setSubmitting(false);

    if (!task) {
      setError('Failed to create task. Please try again.');
      return;
    }
    onClose();
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
          onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) void submit(); }}
        />
        <label class="dialog-label">Priority</label>
        <div class="dialog-agents">
          {(['low', 'medium', 'high'] as const).map(p => (
            <label key={p} class="agent-radio">
              <input type="radio" name="priority" checked={priority === p} onChange={() => setPriority(p)} />
              <span class="agent-chip" style={`--agent-color:${p === 'high' ? 'var(--nx-error)' : p === 'medium' ? 'var(--nx-warning)' : 'var(--nx-text-secondary)'}`}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </span>
            </label>
          ))}
        </div>
        {error && <div class="dialog-error">{error}</div>}
        <div class="dialog-actions">
          <button class="dialog-cancel" onClick={onClose} disabled={submitting}>Cancel</button>
          <button class="dialog-submit" onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
        <div class="dialog-hint">Task will auto-dispatch when an agent is available</div>
      </div>
    </div>
  );
}
