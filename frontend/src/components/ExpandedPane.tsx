import { useEffect, useRef } from 'preact/hooks';
import { expandedPaneId, expandPane, panes, popoutPane, closePopout, popoutPanes } from '../store';
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
  const isPopped = paneId ? popoutPanes.value.has(paneId) : false;
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
        <div class="expanded-header-buttons">
          <button
            class="expanded-popout"
            onClick={() => {
              if (isPopped) closePopout(pane.id);
              else popoutPane(pane.id);
              expandPane(null);
            }}
            title={isPopped ? 'Restore from floating' : 'Pop out to floating window'}
          >
            {isPopped ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            )}
          </button>
          <button class="expanded-close" onClick={() => expandPane(null)} title="Collapse (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
        </div>
        <div class="expanded-content">
          {renderExpandedContent(pane)}
        </div>
      </div>
    </div>
  );
}
