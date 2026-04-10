import { useState, useRef, useEffect } from 'preact/hooks';
import {
  spaces, activeSpaceId,
  panes, archivedPanes, notes, focusPane, createSpace, deletePane, unarchivePane,
  editingNoteId, updateNote, deleteNote,
  exportWorkspace, importWorkspace, currentWorkspaceId,
  workspacePath, setWorkspacePath, ipc,
  tasks, deleteSpace, renameSpace,
} from '../store';
import type { SpaceState } from '../store';

interface Props {
  onAddAgent: (space: SpaceState) => void;
  onAddTask: (space: SpaceState) => void;
  onAddNote: (space: SpaceState) => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
}

function useSystemTheme() {
  const getSystemTheme = () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const [theme, setTheme] = useState<'dark' | 'light'>(getSystemTheme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const newTheme = e.matches ? 'dark' : 'light';
      setTheme(newTheme);
      document.documentElement.setAttribute('data-theme', newTheme);
    };
    document.documentElement.setAttribute('data-theme', theme);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggle = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  return { theme, isDark: theme === 'dark', toggle };
}

export function Sidebar({ onAddAgent, onAddTask, onAddNote, onOpenSettings, onOpenHistory }: Props) {
  const spacesVal = spaces.value;
  const activeId = activeSpaceId.value;
  const [newSpaceName, setNewSpaceName] = useState('');
  const [addingSpace, setAddingSpace] = useState(false);
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set([activeId ?? '']));
  const { isDark, toggle: toggleTheme } = useSystemTheme();
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [spaceCtxMenu, setSpaceCtxMenu] = useState<{ spaceId: string; x: number; y: number } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!spaceCtxMenu) return;
    const close = () => setSpaceCtxMenu(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [spaceCtxMenu]);

  function handleSpaceContextMenu(e: MouseEvent, spaceId: string) {
    e.preventDefault();
    e.stopPropagation();
    setSpaceCtxMenu({ spaceId, x: e.clientX, y: e.clientY });
  }

  function startRename(space: SpaceState) {
    setSpaceCtxMenu(null);
    setRenamingSpaceId(space.id);
    setRenameInput(space.name);
  }

  async function commitRename() {
    if (renamingSpaceId && renameInput.trim()) {
      await renameSpace(renamingSpaceId, renameInput.trim());
    }
    setRenamingSpaceId(null);
    setRenameInput('');
  }

  async function handleDeleteSpace(spaceId: string) {
    setSpaceCtxMenu(null);
    if (spacesVal.length <= 1) return; // prevent deleting last space
    await deleteSpace(spaceId);
  }

  // Auto-expand active space
  useEffect(() => {
    if (activeId) {
      setExpandedSpaces(prev => new Set([...prev, activeId]));
    }
  }, [activeId]);

  function toggleSpaceExpand(spaceId: string) {
    setExpandedSpaces(prev => {
      const next = new Set(prev);
      if (next.has(spaceId)) next.delete(spaceId);
      else next.add(spaceId);
      return next;
    });
  }

  function commitNewSpace() {
    const name = newSpaceName.trim();
    if (name) createSpace(name);
    setNewSpaceName('');
    setAddingSpace(false);
  }

  async function handleExport() {
    const wsId = currentWorkspaceId.value;
    if (!wsId) { alert('No workspace loaded'); return; }
    try {
      const exported = await exportWorkspace();
      const blob = new Blob([exported.bytes], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exported.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  }

  async function handleImport(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      await importWorkspace(file);
    } catch (err) {
      console.error('Import failed:', err);
    }
  }

  async function startEditPath() {
    try {
      const path = await ipc.call<string | null>('dialog.pickFolder', {});
      if (path) {
        await setWorkspacePath(path);
      }
    } catch {
      setPathInput(workspacePath.value);
      setEditingPath(true);
    }
  }

  async function selectPresetPath(path: string) {
    await setWorkspacePath(path);
    setEditingPath(false);
  }

  async function commitPath() {
    const trimmed = pathInput.trim();
    if (trimmed !== workspacePath.value) {
      await setWorkspacePath(trimmed);
    }
    setEditingPath(false);
  }

  return (
    <div class="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-logo">Nexus</span>
        <div class="sidebar-header-actions">
          <button class="sidebar-icon-btn" title={isDark ? 'Light Mode' : 'Dark Mode'} onClick={toggleTheme}>
            {isDark ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
          <button class="sidebar-icon-btn" title="History (Cmd+H)" onClick={onOpenHistory}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>
            </svg>
          </button>
          <button class="sidebar-icon-btn" title="Settings (Cmd+,)" onClick={onOpenSettings}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <button class="sidebar-icon-btn" title="Export Workspace" onClick={handleExport}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          <button class="sidebar-icon-btn" title="Import Workspace" onClick={() => importInputRef.current?.click()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </button>
          <input type="file" ref={importInputRef} accept=".db,.sqlite,.nexus.db,application/octet-stream" style={{ display: 'none' }} onChange={handleImport} />
        </div>
      </div>

      <div class="sidebar-scroll">
        {/* Working Directory */}
        <div class="sidebar-cwd" title="Click to set working directory">
          {editingPath ? (
            <div class="sidebar-cwd-edit">
              <input
                class="sidebar-cwd-input"
                autoFocus
                placeholder="/path/to/project"
                value={pathInput}
                onInput={(e) => setPathInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPath();
                  if (e.key === 'Escape') setEditingPath(false);
                }}
                onBlur={commitPath}
              />
              <div class="sidebar-cwd-presets">
                <button class="cwd-preset" onClick={() => selectPresetPath('~')}>~</button>
                <button class="cwd-preset" onClick={() => selectPresetPath('~/.claude')}>~/.claude</button>
                <button class="cwd-preset" onClick={() => selectPresetPath('~/Documents')}>Documents</button>
              </div>
            </div>
          ) : (
            <div class="sidebar-cwd-display" onClick={startEditPath}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span class="sidebar-cwd-path">{workspacePath.value || 'Set working directory...'}</span>
            </div>
          )}
        </div>

        {/* Spaces — tree-style directory */}
        <div class="sidebar-section">
          <div class="sidebar-section-header">
            <span class="sidebar-section-title">Spaces</span>
            <button class="sidebar-icon-btn" title="New Space" onClick={() => setAddingSpace(true)}>+</button>
          </div>

          <div class="sidebar-list">
            {spacesVal.map(space => {
              const isActive = space.id === activeId;
              const isExpanded = expandedSpaces.has(space.id);
              const isRenaming = renamingSpaceId === space.id;
              const spaceTaskCount = [...tasks.value.values()].filter(t => t.spaceId === space.id).length;
              const spaceSessionCount = panes.value.filter(p => p.spaceId === space.id && !p.embedded && (p.kind === 'shell' || p.kind === 'agent')).length;
              const spaceNoteCount = notes.value.filter(n => n.spaceId === space.id).length;

              return (
                <div key={space.id} class="space-tree-node">
                  {/* Space row */}
                  <div
                    class={`sidebar-item space-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      if (isRenaming) return;
                      activeSpaceId.value = space.id;
                      toggleSpaceExpand(space.id);
                    }}
                    onContextMenu={(e) => handleSpaceContextMenu(e, space.id)}
                  >
                    <span class="space-chevron">{isExpanded ? '▾' : '▸'}</span>
                    {isRenaming ? (
                      <input
                        class="space-rename-input"
                        autoFocus
                        value={renameInput}
                        onInput={(e) => setRenameInput((e.target as HTMLInputElement).value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename();
                          if (e.key === 'Escape') { setRenamingSpaceId(null); }
                        }}
                        onBlur={() => void commitRename()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span class="sidebar-item-label">{space.name}</span>
                    )}
                    {!isRenaming && (spaceTaskCount + spaceSessionCount + spaceNoteCount) > 0 && (
                      <span class="space-count">{spaceTaskCount + spaceSessionCount + spaceNoteCount}</span>
                    )}
                  </div>

                  {/* Space children — only shown when expanded */}
                  {isExpanded && !isRenaming && (
                    <div class="space-children">
                      {/* Quick-add buttons at top */}
                      <div class="space-add-row">
                        <button class="space-add-btn task" onClick={() => onAddTask(space)} title="New Task">
                          + Task
                        </button>
                        <button class="space-add-btn agent" onClick={() => onAddAgent(space)} title="New Agent">
                          + Agent
                        </button>
                        <button class="space-add-btn note" onClick={() => onAddNote(space)} title="New Note">
                          + Note
                        </button>
                      </div>

                      {/* Tasks */}
                      {spaceTaskCount > 0 && (
                        <SpaceTaskList spaceId={space.id} />
                      )}

                      {/* Sessions */}
                      <SpaceSessionList spaceId={space.id} />

                      {/* Notes */}
                      <SpaceNoteList spaceId={space.id} />
                    </div>
                  )}
                </div>
              );
            })}

            {addingSpace && (
              <div class="sidebar-new-space">
                <input
                  class="sidebar-space-input"
                  autoFocus
                  placeholder="Space name…"
                  value={newSpaceName}
                  onInput={(e) => setNewSpaceName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitNewSpace();
                    if (e.key === 'Escape') { setAddingSpace(false); setNewSpaceName(''); }
                  }}
                  onBlur={() => { commitNewSpace(); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Space context menu */}
      {spaceCtxMenu && (
        <div
          class="space-ctx-menu"
          style={{ position: 'fixed', left: spaceCtxMenu.x, top: spaceCtxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button class="space-ctx-item" onClick={() => {
            const space = spacesVal.find(s => s.id === spaceCtxMenu.spaceId);
            if (space) startRename(space);
          }}>
            Rename
          </button>
          <button
            class="space-ctx-item danger"
            onClick={() => void handleDeleteSpace(spaceCtxMenu.spaceId)}
            disabled={spacesVal.length <= 1}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function SpaceTaskList({ spaceId }: { spaceId: string }) {
  const taskList = [...tasks.value.values()]
    .filter(t => t.spaceId === spaceId)
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority] || b.createdAt - a.createdAt;
    });

  if (taskList.length === 0) return null;

  const paneByTaskId = new Map(
    panes.value.filter(p => p.kind === 'task').map(p => [p.id, p] as const),
  );

  return (
    <div class="space-child-group">
      <span class="space-child-label">Tasks</span>
      {taskList.map(task => {
        const pane = paneByTaskId.get(task.id);
        return (
          <div key={task.id} class="task-tree-item" onClick={() => { if (pane) focusPane(pane.id); }}>
            <span class="status-dot-sm" data-status={task.status} />
            <span class="task-tree-title">{task.title || 'Untitled'}</span>
            {pane && (
              <button class="sidebar-delete" onClick={(e) => { e.stopPropagation(); void deletePane(pane.id); }}>x</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SpaceSessionList({ spaceId }: { spaceId: string }) {
  const sessions = panes.value.filter(p =>
    p.spaceId === spaceId && !p.embedded && (p.kind === 'shell' || p.kind === 'agent')
  );
  const archived = archivedPanes.value.filter(p => p.spaceId === spaceId);

  if (sessions.length === 0 && archived.length === 0) return null;

  return (
    <div class="space-child-group">
      <span class="space-child-label">Sessions</span>
      {sessions.map(p => (
        <div key={p.id} class="sidebar-item session-item" onClick={() => focusPane(p.id)}>
          <div class="session-row">
            <span class={`status-dot-sm ${p.sessionStatus === 'running' ? 'active' : ''}`} />
            <span class={`sidebar-badge ${p.kind}`}>
              {p.kind === 'agent' ? (p.agentName ?? 'Agent') : 'Shell'}
            </span>
            <span class="session-id-label">{p.sessionId ?? p.sessionStatus ?? 'idle'}</span>
          </div>
          <button class="sidebar-delete" onClick={(e) => { e.stopPropagation(); void deletePane(p.id); }}>x</button>
        </div>
      ))}
      {archived.map(p => (
        <div key={p.id} class="sidebar-item session-item archived" onClick={() => unarchivePane(p.id)}>
          <div class="session-row">
            <span class="status-dot-sm" />
            <span class={`sidebar-badge ${p.kind}`}>{p.kind}</span>
            <span class="session-id-label">{p.taskTitle ?? p.agentName ?? p.id}</span>
          </div>
          <button class="sidebar-delete" onClick={(e) => { e.stopPropagation(); unarchivePane(p.id); }}>↩</button>
        </div>
      ))}
    </div>
  );
}

function SpaceNoteList({ spaceId }: { spaceId: string }) {
  const spaceNotes = notes.value.filter(n => n.spaceId === spaceId);

  if (spaceNotes.length === 0) return null;

  return (
    <div class="space-child-group">
      <span class="space-child-label">Notes</span>
      {spaceNotes.map(n => {
        const isEditing = editingNoteId.value === n.id;
        return (
          <div key={n.id} class={`sidebar-note ${isEditing ? 'editing' : ''}`}>
            <div class="sidebar-note-header" onClick={() => {
              editingNoteId.value = isEditing ? null : n.id;
            }}>
              <span class="sidebar-note-preview">
                {n.text.slice(0, 40) || 'Empty note'}{n.text.length > 40 ? '...' : ''}
              </span>
              <button class="sidebar-delete" onClick={(e) => { e.stopPropagation(); deleteNote(n.id); }}>x</button>
            </div>
            {isEditing && (
              <textarea
                class="sidebar-note-editor"
                value={n.text}
                onInput={(e) => updateNote(n.id, (e.target as HTMLTextAreaElement).value)}
                placeholder="Write your note..."
                rows={4}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
