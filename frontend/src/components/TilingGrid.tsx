import { useRef, useEffect, useState } from 'preact/hooks';
import { TerminalPane } from './TerminalPane';
import { TaskPane } from './TaskPane';
import { TaskEditDialog } from './TaskEditDialog';
import { activeSpaceGridPanes, layoutMode } from '../store';
import type { PaneState } from '../store';

export function TilingGrid() {
  const gridRef = useRef<HTMLDivElement>(null);
  const panesVal = activeSpaceGridPanes.value;
  const mode = layoutMode.value;
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  function renderPane(pane: PaneState) {
    switch (pane.kind) {
      case 'shell':
      case 'agent':
        return <TerminalPane pane={pane} />;
      case 'task':
        return <TaskPane pane={pane} onEdit={setEditingTaskId} />;
    }
  }

  // Fix column width: % in overflow-x:auto grids is based on scroll width, not visible width.
  // Use ResizeObserver to set --grid-col-w from the actual container visible width.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const gap = 3; // --cove-gap
    const update = (w: number) => {
      const colW = mode === 'vertical'
        ? Math.max(280, w - gap * 2)
        : Math.max(180, Math.floor((w - gap * 3) / 2));
      el.style.setProperty('--grid-col-w', `${colW}px`);
    };
    const ro = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    ro.observe(el);
    update(el.clientWidth);
    return () => ro.disconnect();
  }, [mode]);

  if (panesVal.length === 0) {
    return (
      <div class="tiling-grid empty">
        <div class="empty-state">
          <div class="empty-icon">+</div>
          <div>Create a task or agent to get started</div>
          <div class="empty-hint">
            <kbd>Cmd+T</kbd> task &nbsp; <kbd>Cmd+K</kbd> agent &nbsp; <kbd>Cmd+J</kbd> note
          </div>
        </div>
      </div>
    );
  }

  // Auto-scroll to right when new pane added
  requestAnimationFrame(() => {
    if (gridRef.current) {
      gridRef.current.scrollLeft = gridRef.current.scrollWidth;
    }
  });

  return (
    <>
      <div class={`tiling-grid ${mode}`} ref={gridRef}>
        {panesVal.map(pane => (
          <div key={pane.id} class="grid-cell">
            {renderPane(pane)}
          </div>
        ))}
      </div>
      {editingTaskId && (
        <TaskEditDialog taskId={editingTaskId} onClose={() => setEditingTaskId(null)} />
      )}
    </>
  );
}
