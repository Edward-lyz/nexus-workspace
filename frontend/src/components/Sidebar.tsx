import { useState, useRef } from 'preact/hooks';
import {
  spaces, activeSpaceId, activeSpacePanes, activeSpaceNotes,
  panes, archivedPanes, notes, focusPane, createSpace, deletePane, unarchivePane,
  editingNoteId, updateNote, deleteNote,
  exportWorkspace, importWorkspace, currentWorkspaceId,
  workspacePath, setWorkspacePath, ipc,
  activeSpaceTasks, tasks,
} from '../store';
import type { SpaceState } from '../store';

interface Props {
  onAddAgent: (space: SpaceState) => void;
  onAddTask: (space: SpaceState) => void;
  onAddNote: (space: SpaceState) => void;
}

export function Sidebar({ onAddAgent, onAddTask, onAddNote }: Props) {
  const spacesVal = spaces.value;
  const activeId = activeSpaceId.value;
  const currentPanes = activeSpacePanes.value;
  const currentNotes = activeSpaceNotes.value;
  const activeSpaceVal = spacesVal.find(s => s.id === activeId);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [addingSpace, setAddingSpace] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);

  const terminals = currentPanes.filter(p => (p.kind === 'shell' || p.kind === 'agent') && !p.embedded);
  const archivedForSpace = archivedPanes.value.filter((pane) => pane.spaceId === activeId);

  function toggleTheme() {
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    setIsDark(!isDark);
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
    // Use native folder picker
    try {
      const path = await ipc.call<string | null>('dialog.pickFolder', {});
      if (path) {
        await setWorkspacePath(path);
      }
    } catch (err) {
      // Fallback to manual input
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
          <input type="file" ref={importInputRef} accept=".db,.sqlite,.cove.db,application/octet-stream" style={{ display: 'none' }} onChange={handleImport} />
        </div>
      </div>

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

      {/* Spaces */}
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span class="sidebar-section-title">Spaces</span>
          <button class="sidebar-icon-btn" title="New Space" onClick={() => setAddingSpace(true)}>+</button>
        </div>
        <div class="sidebar-list">
          {spacesVal.map(space => {
            const count = panes.value.filter(p => p.spaceId === space.id && !p.embedded).length;
            return (
              <div key={space.id} class={`sidebar-item ${space.id === activeId ? 'active' : ''}`}
                onClick={() => { activeSpaceId.value = space.id; }}>
                <span class="sidebar-item-label">{space.name}</span>
                <span class="space-count">{count > 0 ? count : ''}</span>
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

      {activeSpaceVal && (
        <div class="sidebar-detail">
          <div class="space-actions">
            <button class="sidebar-btn task" onClick={() => onAddTask(activeSpaceVal)}>+ Task</button>
            <button class="sidebar-btn agent" onClick={() => onAddAgent(activeSpaceVal)}>+ Agent</button>
            <button class="sidebar-btn note" onClick={() => onAddNote(activeSpaceVal)}>+ Note</button>
          </div>

          {/* Tasks - Tree View */}
          {tasks.value.size > 0 && (
            <SidebarGroup title="Tasks">
              <TaskListView />
            </SidebarGroup>
          )}

          {/* Sessions (non-embedded only) */}
          {terminals.length > 0 && (
            <SidebarGroup title="Sessions">
              {terminals.map(p => (
                <div key={p.id} class="sidebar-item session-item" onClick={() => focusPane(p.id)}>
                  <div class="session-row">
                    <span class={`status-dot-sm ${p.sessionStatus === 'running' ? 'active' : ''}`} />
                    <span class={`sidebar-badge ${p.kind}`}>
                      {p.kind === 'agent' ? (p.agentName ?? 'Agent') : 'Shell'}
                    </span>
                    <span class="session-id-label">{p.sessionId ?? p.sessionStatus ?? 'idle'}</span>
                    {p.needsAttention && <span class="task-link-status">attention</span>}
                  </div>
                  <button class="sidebar-delete" onClick={(e) => { e.stopPropagation(); void deletePane(p.id); }}>x</button>
                </div>
              ))}
            </SidebarGroup>
          )}

          {archivedForSpace.length > 0 && (
            <SidebarGroup title="Archive">
              {archivedForSpace.map((pane) => (
                <div key={pane.id} class="sidebar-item session-item" onClick={() => unarchivePane(pane.id)}>
                  <div class="session-row">
                    <span class="status-dot-sm" />
                    <span class={`sidebar-badge ${pane.kind}`}>{pane.kind}</span>
                    <span class="session-id-label">{pane.taskTitle ?? pane.agentName ?? pane.id}</span>
                  </div>
                  <button class="sidebar-delete" onClick={(e) => { e.stopPropagation(); unarchivePane(pane.id); }}>restore</button>
                </div>
              ))}
            </SidebarGroup>
          )}

          {/* Notes — inline editable, sidebar-only */}
          <SidebarGroup title="Notes">
            {currentNotes.map(n => {
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
            {currentNotes.length === 0 && (
              <div class="sidebar-empty">No notes yet</div>
            )}
          </SidebarGroup>
        </div>
      )}
    </div>
  );
}

function SidebarGroup({ title, children }: { title: string; children: any }) {
  return (
    <div class="sidebar-group">
      <div class="sidebar-section-title">{title}</div>
      <div class="sidebar-list">{children}</div>
    </div>
  );
}

function TaskListView() {
  const taskList = [...activeSpaceTasks.value].sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.createdAt - a.createdAt;
  });
  const paneByTaskId = new Map(
    panes.value
      .filter((pane) => pane.kind === 'task')
      .map((pane) => [pane.id, pane] as const),
  );

  if (taskList.length === 0) {
    return <div class="sidebar-empty">No tasks yet</div>;
  }

  return (
    <div class="task-tree">
      {taskList.map((task) => {
        const pane = paneByTaskId.get(task.id);
        const handleOpen = () => {
          if (pane) focusPane(pane.id);
        };
        const handleDelete = (e: MouseEvent) => {
          e.stopPropagation();
          if (pane) void deletePane(pane.id);
        };

        return (
          <div key={task.id} class="task-tree-item" onClick={handleOpen}>
            <span class="status-dot-sm" data-status={task.status} />
            <span class="task-tree-title">{task.title || 'Untitled'}</span>
            {pane ? (
              <button class="sidebar-delete" onClick={handleDelete}>
                x
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
