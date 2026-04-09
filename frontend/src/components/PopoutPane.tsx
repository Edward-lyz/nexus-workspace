import { useRef, useEffect, useState } from 'preact/hooks';
import { popoutPanes, closePopout, updatePopout, bringPopoutToFront, panes } from '../store';
import { TerminalPane } from './TerminalPane';
import { TaskPane } from './TaskPane';
import type { PaneState, PopoutPane as PopoutPaneState } from '../store';

function renderPaneContent(pane: PaneState) {
  switch (pane.kind) {
    case 'shell':
    case 'agent':
      return <TerminalPane pane={pane} />;
    case 'task':
      return <TaskPane pane={pane} />;
  }
}

interface PopoutWindowProps {
  popout: PopoutPaneState;
  pane: PaneState;
}

function PopoutWindow({ popout, pane }: PopoutWindowProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, startW: 0, startH: 0 });

  // Drag handling
  const handleDragStart = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.popout-close') ||
        (e.target as HTMLElement).closest('.popout-resize')) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      startX: popout.x,
      startY: popout.y,
    };
    bringPopoutToFront(popout.paneId);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      updatePopout(popout.paneId, {
        x: Math.max(0, dragStart.current.startX + dx),
        y: Math.max(0, dragStart.current.startY + dy),
      });
    };

    const handleUp = () => setIsDragging(false);

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging, popout.paneId]);

  // Resize handling
  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      startW: popout.width,
      startH: popout.height,
    };
    bringPopoutToFront(popout.paneId);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStart.current.x;
      const dy = e.clientY - resizeStart.current.y;
      updatePopout(popout.paneId, {
        width: Math.max(300, resizeStart.current.startW + dx),
        height: Math.max(200, resizeStart.current.startH + dy),
      });
    };

    const handleUp = () => setIsResizing(false);

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isResizing, popout.paneId]);

  const badgeLabel = pane.kind === 'task'
    ? (pane.taskTitle || 'Task')
    : pane.kind === 'agent'
      ? (pane.agentName || 'Agent')
      : 'Shell';

  return (
    <div
      ref={windowRef}
      class="popout-window"
      style={{
        left: `${popout.x}px`,
        top: `${popout.y}px`,
        width: `${popout.width}px`,
        height: `${popout.height}px`,
        zIndex: popout.zIndex,
      }}
      onMouseDown={() => bringPopoutToFront(popout.paneId)}
    >
      <div class="popout-header" onMouseDown={handleDragStart}>
        <span class="popout-title">{badgeLabel}</span>
        <button
          class="popout-close"
          onClick={() => closePopout(popout.paneId)}
          title="Close popout"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="popout-content">
        {renderPaneContent(pane)}
      </div>
      <div class="popout-resize" onMouseDown={handleResizeStart}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 20 20 20 20 16"/><line x1="14" y1="14" x2="20" y2="20"/>
        </svg>
      </div>
    </div>
  );
}

export function PopoutContainer() {
  const popouts = Array.from(popoutPanes.value.values());
  const allPanes = panes.value;

  if (popouts.length === 0) return null;

  return (
    <div class="popout-container">
      {popouts.map(popout => {
        const pane = allPanes.find(p => p.id === popout.paneId);
        if (!pane) return null;
        return <PopoutWindow key={popout.paneId} popout={popout} pane={pane} />;
      })}
    </div>
  );
}
