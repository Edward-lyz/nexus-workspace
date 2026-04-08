import { useEffect, useRef } from 'preact/hooks';

export interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  separator?: boolean;
  action?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let adjX = x, adjY = y;
    if (x + rect.width > vw - 8) adjX = vw - rect.width - 8;
    if (y + rect.height > vh - 8) adjY = vh - rect.height - 8;
    if (adjX < 8) adjX = 8;
    if (adjY < 8) adjY = 8;
    menuRef.current.style.left = `${adjX}px`;
    menuRef.current.style.top = `${adjY}px`;
  }, [x, y]);

  return (
    <div class="context-menu" ref={menuRef} style={{ left: x, top: y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} class="context-menu-separator" />
        ) : (
          <button
            key={i}
            class={`context-menu-item ${item.danger ? 'context-menu-item--danger' : ''}`}
            onClick={() => {
              item.action?.();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span class="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
}
