import { useEffect, useRef } from 'preact/hooks';
import { expandedPaneId, expandPane, panes } from '../store';
import { TerminalPane } from './TerminalPane';
import { TaskPane } from './TaskPane';
import type { PaneState } from '../store';

function renderExpandedContent(pane: PaneState) {
  switch (pane.kind) {
    case 'shell':
    case 'agent':
      return <TerminalPane pane={pane} />;
    case 'task':
      return <TaskPane pane={pane} />;
  }
}

export function ExpandedPane() {
  const paneId = expandedPaneId.value;
  const pane = paneId ? panes.value.find(p => p.id === paneId) : null;
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pane) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        expandPane(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pane]);

  if (!pane) return null;

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === overlayRef.current) {
      expandPane(null);
    }
  };

  return (
    <div class="expanded-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div class="expanded-container">
        <button class="expanded-close" onClick={() => expandPane(null)} title="Close (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
          </svg>
        </button>
        <div class="expanded-content">
          {renderExpandedContent(pane)}
        </div>
      </div>
    </div>
  );
}
