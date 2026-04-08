import { useRef, useEffect } from 'preact/hooks';
import { createNote } from '../store';

interface Props {
  onClose: () => void;
}

export function NoteDialog({ onClose }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { textRef.current?.focus(); }, []);

  const submit = () => {
    const text = textRef.current?.value.trim();
    if (!text) return;
    createNote(text);
    onClose();
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog">
        <div class="dialog-header">New Note</div>
        <label class="dialog-label">Content</label>
        <textarea
          ref={textRef}
          class="dialog-textarea"
          rows={5}
          placeholder="Write your note..."
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
        />
        <div class="dialog-actions">
          <button class="dialog-cancel" onClick={onClose}>Cancel</button>
          <button class="dialog-submit" onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}
