import { useRef, useEffect } from 'preact/hooks';
import { TerminalPane } from './TerminalPane';
import { TaskPane } from './TaskPane';
import { activeSpaceGridPanes } from '../store';
import type { PaneState } from '../store';

function renderPane(pane: PaneState) {
  switch (pane.kind) {
    case 'shell':
    case 'agent':
      return <TerminalPane pane={pane} />;
    case 'task':
      return <TaskPane pane={pane} />;
  }
}

export function TilingGrid() {
  const gridRef = useRef<HTMLDivElement>(null);
  const panesVal = activeSpaceGridPanes.value;

  // Fix column width: % in overflow-x:auto grids is based on scroll width, not visible width.
  // Use ResizeObserver to set --grid-col-w from the actual container visible width.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const gap = 3; // --cove-gap
    const update = (w: number) => {
      const colW = Math.max(180, Math.floor((w - gap * 3) / 2));
      el.style.setProperty('--grid-col-w', `${colW}px`);
    };
    const ro = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    ro.observe(el);
    update(el.clientWidth);
    return () => ro.disconnect();
  }, []);

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
    <div class="tiling-grid" ref={gridRef}>
      {panesVal.map(pane => (
        <div key={pane.id} class="grid-cell">
          {renderPane(pane)}
        </div>
      ))}
    </div>
  );
}
