import { signal, computed, effect } from '@preact/signals';
import { IpcClient } from './ipc';

export const ipc = new IpcClient();

// -- Task & Agent data models for persistence --
export interface TaskData {
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'done';
  priority: 'low' | 'medium' | 'high';
  createdAt: number;
  assignedAgentId?: string;
}

export interface AgentData {
  providerId: string;
  providerName: string;
  prompt: string;
  status: 'idle' | 'running' | 'exited';
  startedAt: number;
}

// -- Scheduler settings --
export interface SchedulerSettings {
  concurrency: number;
  autoDispatch: boolean;
}

export const schedulerSettings = signal<SchedulerSettings>({
  concurrency: 2,
  autoDispatch: false,
});

// -- Agent providers --
export interface AgentProvider {
  id: string;
  name: string;
  command: string;
  color: string;
}

export const BUILTIN_AGENTS: AgentProvider[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', color: '#cba6f7' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', color: '#f9e2af' },
  { id: 'copilot', name: 'Copilot CLI', command: 'gh copilot suggest', color: '#a6e3a1' },
];

// -- Pane model (terminal + task only, notes are sidebar-only) --
export type PaneKind = 'shell' | 'agent' | 'task';

export interface PaneState {
  id: string;
  kind: PaneKind;
  spaceId: string;
  sessionId?: string;
  agentName?: string;
  prompt?: string;
  sessionStatus?: 'running' | 'exited';
  taskTitle?: string;
  taskDescription?: string;
  taskStatus?: 'todo' | 'doing' | 'done';
  taskPriority?: 'low' | 'medium' | 'high';
  linkedPaneId?: string;
  embedded?: boolean; // agent/shell spawned inline inside a task pane
}

export const panes = signal<PaneState[]>([]);
export const focusedPaneId = signal<string | null>(null);

// -- Note model (sidebar-only, persistent) --
export interface NoteState {
  id: string;
  spaceId: string;
  text: string;
  linkedPaneId?: string;
  createdAt: number;
}

export const notes = signal<NoteState[]>([]);
export const editingNoteId = signal<string | null>(null);

// -- Space model --
export interface SpaceState { id: string; name: string; }

export const spaces = signal<SpaceState[]>([]);
export const activeSpaceId = signal<string | null>(null);
export const currentWorkspaceId = signal<string | null>(null);
export const workspacePath = signal<string>(''); // Default working directory for this workspace

export const activeSpace = computed(() =>
  spaces.value.find(s => s.id === activeSpaceId.value) ?? null
);

export const activeSpacePanes = computed(() =>
  panes.value.filter(p => p.spaceId === activeSpaceId.value)
);

// Only non-embedded panes go into the tiling grid
export const activeSpaceGridPanes = computed(() =>
  panes.value.filter(p => p.spaceId === activeSpaceId.value && !p.embedded)
);

export const activeSpaceNotes = computed(() =>
  notes.value.filter(n => n.spaceId === activeSpaceId.value)
);

// -- Internal helpers --

let paneCounter = 0;
let noteCounter = 0;
function nextPaneId(): string { return `pane-${++paneCounter}`; }
function nextNoteId(): string { return `note-${++noteCounter}`; }

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function spawnTerminal(
  kind: 'shell' | 'agent',
  agentName?: string,
  command?: string,
  prompt?: string,
): Promise<PaneState | null> {
  const space = activeSpace.value;
  if (!space) return null;

  // Use workspace path as cwd, default to home/.claude for agents
  const cwd = workspacePath.value || undefined;
  const params: Record<string, unknown> = { kind, space_id: space.id };
  if (cwd) params.cwd = cwd;
  if (command) params.command = command;

  let result: { session_id: string };
  try {
    result = await ipc.call<{ session_id: string }>('pty.spawn', params);
  } catch (err) {
    console.error('pty.spawn failed:', err);
    return null;
  }

  const pane: PaneState = {
    id: nextPaneId(),
    kind,
    spaceId: space.id,
    sessionId: result.session_id,
    agentName,
    prompt,
    sessionStatus: 'running',
  };

  panes.value = [...panes.value, pane];
  focusedPaneId.value = pane.id;
  return pane;
}

// -- Public actions --

export async function spawnAgent(agentId: string, prompt: string): Promise<PaneState | null> {
  const agent = BUILTIN_AGENTS.find(a => a.id === agentId);
  if (!agent) return null;

  // Launch interactive TUI
  const pane = await spawnTerminal('agent', agent.name, agent.command, prompt);

  // If prompt provided, wait for TUI to fully start then send it with newline to auto-execute
  if (pane?.sessionId && prompt) {
    // Wait 2.5s for Claude TUI to be fully ready
    setTimeout(() => {
      // Send prompt followed by Enter key
      ipc.call('pty.write', { session_id: pane.sessionId, data: prompt + '\r' }).catch(() => {});
    }, 2500);
  }
  return pane;
}

// Spawn agent CLI directly without prompt (just starts the CLI)
export async function spawnAgentDirect(agentId: string): Promise<PaneState | null> {
  const agent = BUILTIN_AGENTS.find(a => a.id === agentId);
  if (!agent) return null;
  return spawnTerminal('agent', agent.name, agent.command);
}

export async function spawnShellForTask(taskPaneId: string): Promise<void> {
  const shellPane = await spawnTerminal('shell');
  if (shellPane) {
    updatePane(shellPane.id, { embedded: true });
    linkPane(taskPaneId, shellPane.id);
  }
}

export async function spawnAgentForTask(taskPaneId: string, agentId: string, prompt: string): Promise<void> {
  const agentPane = await spawnAgent(agentId, prompt);
  if (agentPane) {
    updatePane(agentPane.id, { embedded: true });
    linkPane(taskPaneId, agentPane.id);
    updatePane(taskPaneId, { taskStatus: 'doing' });
  }
}

export function createTask(title: string, description: string, priority: 'low' | 'medium' | 'high' = 'medium'): PaneState | null {
  const space = activeSpace.value;
  if (!space) return null;
  const pane: PaneState = {
    id: nextPaneId(), kind: 'task', spaceId: space.id,
    taskTitle: title, taskDescription: description, taskStatus: 'todo', taskPriority: priority,
  };
  panes.value = [...panes.value, pane];
  focusedPaneId.value = pane.id;
  return pane;
}

export function createNote(text: string): NoteState | null {
  const space = activeSpace.value;
  if (!space) return null;
  const note: NoteState = {
    id: nextNoteId(), spaceId: space.id, text, createdAt: Date.now(),
  };
  notes.value = [...notes.value, note];
  editingNoteId.value = note.id;
  return note;
}

export function updateNote(noteId: string, text: string) {
  notes.value = notes.value.map(n => n.id === noteId ? { ...n, text } : n);
}

export function deleteNote(noteId: string) {
  notes.value = notes.value.filter(n => n.id !== noteId);
  if (editingNoteId.value === noteId) editingNoteId.value = null;
}

export function linkNoteToPane(noteId: string, paneId: string) {
  notes.value = notes.value.map(n => n.id === noteId ? { ...n, linkedPaneId: paneId } : n);
}

export function updatePane(paneId: string, updates: Partial<PaneState>) {
  panes.value = panes.value.map(p => p.id === paneId ? { ...p, ...updates } : p);
}

export function linkPane(sourcePaneId: string, targetPaneId: string) {
  updatePane(sourcePaneId, { linkedPaneId: targetPaneId });
}

export function deletePane(paneId: string) {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane) return;
  if (pane.sessionId) ipc.call('pty.kill', { session_id: pane.sessionId });
  panes.value = panes.value
    .filter(p => p.id !== paneId)
    .map(p => p.linkedPaneId === paneId ? { ...p, linkedPaneId: undefined } : p);
  // Also unlink notes pointing to this pane
  notes.value = notes.value.map(n => n.linkedPaneId === paneId ? { ...n, linkedPaneId: undefined } : n);
  if (focusedPaneId.value === paneId) {
    const remaining = panes.value;
    focusedPaneId.value = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
  }
}

export function markSessionExited(sessionId: string) {
  panes.value = panes.value.map(p =>
    p.sessionId === sessionId ? { ...p, sessionStatus: 'exited' as const } : p
  );
}

// -- Workspace Path (default working directory) --

export async function setWorkspacePath(path: string): Promise<void> {
  const wsId = currentWorkspaceId.value;
  if (!wsId) return;
  try {
    await ipc.call('workspace.setPath', { workspace_id: wsId, path });
    workspacePath.value = path;
  } catch (err) {
    console.error('setWorkspacePath failed:', err);
  }
}

export async function getWorkspacePath(): Promise<string> {
  const wsId = currentWorkspaceId.value;
  if (!wsId) return '';
  try {
    const path = await ipc.call<string>('workspace.getPath', { workspace_id: wsId });
    workspacePath.value = path;
    return path;
  } catch {
    return '';
  }
}

// -- Context Migration --

type TerminalRegistry = Map<string, { buffer: { active: { getLine: (row: number) => { translateToString: () => string } | undefined }; viewportY: number; cursorY: number } }>;

export async function exportTaskContext(taskPaneId: string, terminalRegistry: TerminalRegistry): Promise<string> {
  const pane = panes.value.find(p => p.id === taskPaneId);
  if (!pane) return '';

  const linked = pane.linkedPaneId ? panes.value.find(p => p.id === pane.linkedPaneId) : null;
  const lines: string[] = [];

  lines.push(`# Task: ${pane.taskTitle ?? 'Untitled'}`);
  lines.push('');
  if (pane.taskDescription) {
    lines.push('## Description');
    lines.push(pane.taskDescription);
    lines.push('');
  }
  lines.push(`**Status:** ${pane.taskStatus ?? 'todo'}`);
  lines.push(`**Priority:** ${pane.taskPriority ?? 'medium'}`);
  lines.push('');

  // Extract terminal content if available
  if (linked?.sessionId) {
    const term = terminalRegistry.get(linked.sessionId);
    if (term) {
      lines.push('## Terminal Output');
      lines.push('```');
      const buffer = term.buffer.active;
      const maxLines = Math.min(500, buffer.viewportY + buffer.cursorY + 1);
      for (let i = 0; i < maxLines; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString().trimEnd());
      }
      lines.push('```');
    }
  }

  return lines.join('\n');
}

export async function cloneTaskToAgent(
  sourcePaneId: string,
  targetAgentId: string,
  terminalRegistry: TerminalRegistry
): Promise<PaneState | null> {
  const sourcePane = panes.value.find(p => p.id === sourcePaneId);
  if (!sourcePane) return null;

  const context = await exportTaskContext(sourcePaneId, terminalRegistry);

  // Get the old linked agent/shell pane
  const oldLinked = sourcePane.linkedPaneId ? panes.value.find(p => p.id === sourcePane.linkedPaneId) : null;

  // Kill old session if running
  if (oldLinked?.sessionId && oldLinked.sessionStatus === 'running') {
    await ipc.call('pty.kill', { session_id: oldLinked.sessionId });
  }

  // Mark old linked pane as collapsed (keep in history but unlink)
  if (oldLinked) {
    updatePane(oldLinked.id, { embedded: true, sessionStatus: 'exited' });
  }

  // Unlink the old agent from the task
  updatePane(sourcePaneId, { linkedPaneId: undefined, taskStatus: 'todo' });

  // Now spawn new agent in the same task pane with context
  const promptWithContext = `${sourcePane.taskDescription ?? sourcePane.taskTitle ?? ''}\n\n---\n## Previous Context\n${context}`;
  await spawnAgentForTask(sourcePaneId, targetAgentId, promptWithContext);

  return sourcePane;
}

// Clone standalone agent session to another agent
export async function cloneAgentToAgent(
  sourcePaneId: string,
  targetAgentId: string,
  terminalRegistry: TerminalRegistry
): Promise<PaneState | null> {
  const sourcePane = panes.value.find(p => p.id === sourcePaneId);
  if (!sourcePane || sourcePane.kind !== 'agent') return null;

  // Extract terminal content as context
  const lines: string[] = [];
  lines.push(`## Previous Agent: ${sourcePane.agentName ?? 'Unknown'}`);
  if (sourcePane.prompt) {
    lines.push(`**Prompt:** ${sourcePane.prompt}`);
  }
  lines.push('');

  if (sourcePane.sessionId) {
    const term = terminalRegistry.get(sourcePane.sessionId);
    if (term) {
      lines.push('### Terminal Output');
      lines.push('```');
      const buffer = term.buffer.active;
      const maxLines = Math.min(500, buffer.viewportY + buffer.cursorY + 1);
      for (let i = 0; i < maxLines; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString().trimEnd());
      }
      lines.push('```');
    }
  }

  const context = lines.join('\n');

  // Kill old session
  if (sourcePane.sessionId && sourcePane.sessionStatus === 'running') {
    await ipc.call('pty.kill', { session_id: sourcePane.sessionId });
  }
  updatePane(sourcePaneId, { sessionStatus: 'exited' });

  // Spawn new agent with context
  const newPane = await spawnAgent(targetAgentId, context);
  return newPane;
}

export function focusPane(paneId: string) {
  focusedPaneId.value = paneId;
}

export function createSpace(name: string) {
  const id = `space-${Date.now()}`;
  spaces.value = [...spaces.value, { id, name }];
  activeSpaceId.value = id;
}

export function getLinkedPane(paneId: string): PaneState | undefined {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane?.linkedPaneId) return undefined;
  return panes.value.find(p => p.id === pane.linkedPaneId);
}

// -- Scheduler computed values --

export const pendingTasks = computed(() =>
  panes.value
    .filter(p => p.kind === 'task' && p.taskStatus === 'todo')
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const pa = priorityOrder[a.taskPriority ?? 'medium'];
      const pb = priorityOrder[b.taskPriority ?? 'medium'];
      return pa - pb;
    })
);

export const runningTasks = computed(() =>
  panes.value.filter(p => p.kind === 'task' && p.taskStatus === 'doing')
);

export const availableSlots = computed(() =>
  Math.max(0, schedulerSettings.value.concurrency - runningTasks.value.length)
);

// -- Hydration (restore state from backend) --

interface HydratedNode {
  id: string;
  space_id: string;
  kind: string;
  title: string;
  session_id: string | null;
  agent_json: string | null;
  task_json: string | null;
  sort_order: number;
}

interface HydratedSpace {
  id: string;
  workspace_id: string;
  name: string;
  nodes: HydratedNode[];
}

interface HydratedWorkspace {
  id: string;
  name: string;
  spaces: HydratedSpace[];
}

interface HydratedState {
  workspaces: HydratedWorkspace[];
  settings: Record<string, unknown>;
}

export async function hydrateState(): Promise<void> {
  try {
    const state = await ipc.call<HydratedState>('state.hydrate', {});

    // Restore spaces and panes from first workspace
    if (state.workspaces.length > 0) {
      const ws = state.workspaces[0];
      const restoredSpaces: SpaceState[] = [];
      const restoredPanes: PaneState[] = [];
      currentWorkspaceId.value = ws.id;

      // Restore workspace path (default cwd)
      workspacePath.value = ws.path || '';

      for (const sp of ws.spaces) {
        restoredSpaces.push({ id: sp.id, name: sp.name });

        for (const node of sp.nodes) {
          const pane: PaneState = {
            id: node.id,
            kind: node.kind as PaneKind,
            spaceId: sp.id,
            sessionId: undefined, // Will be assigned after spawn
            sessionStatus: 'exited', // Mark as exited initially
          };

          if (node.task_json) {
            try {
              const task = JSON.parse(node.task_json) as TaskData;
              pane.taskTitle = task.title;
              pane.taskDescription = task.description;
              pane.taskStatus = task.status;
              pane.taskPriority = task.priority;
            } catch {}
          }

          if (node.agent_json) {
            try {
              const agent = JSON.parse(node.agent_json) as AgentData;
              pane.agentName = agent.providerName;
              pane.prompt = agent.prompt;
            } catch {}
          }

          restoredPanes.push(pane);
        }
      }

      if (restoredSpaces.length > 0) {
        spaces.value = restoredSpaces;
        panes.value = restoredPanes;
        activeSpaceId.value = restoredSpaces[0].id;

        // Use workspace path for spawning, or default
        const cwd = ws.path || undefined;

        // Re-spawn PTY sessions for agents and tasks that need them
        for (const pane of restoredPanes) {
          if (pane.kind === 'agent' || pane.kind === 'task') {
            try {
              const resp = await ipc.call<{ session_id: string }>('pty.spawn', {
                cwd,
                kind: 'agent',
                space_id: pane.spaceId,
                node_id: pane.id,
              });
              updatePane(pane.id, {
                sessionId: resp.session_id,
                sessionStatus: 'running',
              });
            } catch (err) {
              console.warn('Failed to respawn PTY for', pane.id, err);
            }
          }
        }
        return;
      }
    }

    // Fall back to creating default space
    createSpace('Default');
  } catch (err) {
    console.error('hydrateState failed:', err);
    createSpace('Default');
  }
}

// -- Persist a single pane to backend --

export async function persistPane(paneId: string): Promise<void> {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane) return;

  const updates: Record<string, unknown> = { node_id: pane.id };

  if (pane.kind === 'task') {
    const taskData: TaskData = {
      title: pane.taskTitle ?? '',
      description: pane.taskDescription ?? '',
      status: pane.taskStatus ?? 'todo',
      priority: pane.taskPriority ?? 'medium',
      createdAt: Date.now(),
    };
    updates.task_json = JSON.stringify(taskData);
  }

  if (pane.kind === 'agent' && pane.agentName) {
    const agent = BUILTIN_AGENTS.find(a => a.name === pane.agentName);
    const agentData: AgentData = {
      providerId: agent?.id ?? 'unknown',
      providerName: pane.agentName,
      prompt: pane.prompt ?? '',
      status: pane.sessionStatus === 'exited' ? 'exited' : 'running',
      startedAt: Date.now(),
    };
    updates.agent_json = JSON.stringify(agentData);
  }

  try {
    await ipc.call('node.update', updates);
  } catch (err) {
    console.error('persistPane failed:', err);
  }
}

// -- Export/Import workspace --

export async function exportWorkspace(workspaceId: string): Promise<string> {
  try {
    const result = await ipc.call<{ json: string }>('workspace.export', { workspace_id: workspaceId });
    return result.json;
  } catch (err) {
    console.error('exportWorkspace failed:', err);
    throw err;
  }
}

export async function importWorkspace(json: string): Promise<void> {
  try {
    await ipc.call('workspace.import', { json });
    await hydrateState();
  } catch (err) {
    console.error('importWorkspace failed:', err);
    throw err;
  }
}

// -- Auto dispatch effect --

effect(() => {
  const settings = schedulerSettings.value;
  if (!settings.autoDispatch) return;

  const slots = availableSlots.value;
  const pending = pendingTasks.value;

  if (slots > 0 && pending.length > 0) {
    // Auto-dispatch highest priority task
    const task = pending[0];
    // Spawn default agent (Claude) for the task
    spawnAgentForTask(task.id, 'claude', task.taskDescription ?? task.taskTitle ?? '');
  }
});
