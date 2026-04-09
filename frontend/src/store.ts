import { signal, computed, effect } from '@preact/signals';
import { IpcClient } from './ipc';

export const ipc = new IpcClient();

// -- Persisted Entity Models (from backend) --

export interface TaskEntity {
  id: string;
  spaceId: string;
  parentTaskId?: string;
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'done';
  priority: 'low' | 'medium' | 'high';
  queueStatus: 'none' | 'queued' | 'dispatched' | 'completed' | 'failed';
  queuedAt?: number;
  dispatchedAt?: number;
  completedAt?: number;
  assignedAgentId?: string;
  nodeId?: string;
  sortOrder: number;
  createdAt: number;
}

export interface AgentEntity {
  id: string;
  spaceId: string;
  providerId: string;
  providerName: string;
  status: 'idle' | 'running' | 'exited';
  sessionId?: string;
  assignedTaskId?: string;
  prompt?: string;
  startedAt?: number;
  nodeId?: string;
  sortOrder: number;
  createdAt: number;
}

export interface SchedulerSettingsEntity {
  workspaceId: string;
  concurrency: number;
  autoDispatch: boolean;
  defaultAgentId: string;
}

// -- Persisted signals --
export const tasks = signal<Map<string, TaskEntity>>(new Map());
export const agents = signal<Map<string, AgentEntity>>(new Map());
export const schedulerSettingsEntity = signal<SchedulerSettingsEntity | null>(null);

// -- Legacy models (kept for backward compatibility during migration) --
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

// -- Agent Pool Entry (now derived from AgentEntity) --
export interface AgentPoolEntry {
  slotId: string;           // "slot-1" ~ "slot-4"
  status: 'idle' | 'running';
  sessionId?: string;
  assignedTaskId?: string;
  agentProviderId: string;
  startedAt?: number;
}

// -- Task Pool Entry (now derived from TaskEntity) --
export interface TaskPoolEntry {
  taskId: string;
  status: 'queued' | 'dispatched' | 'completed' | 'failed';
  assignedSlotId?: string;
  queuedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
}

// -- Scheduler settings --
export interface SchedulerSettings {
  concurrency: number;
  autoDispatch: boolean;
  defaultAgentId: string;
}

const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  concurrency: 4,
  autoDispatch: true,
  defaultAgentId: 'claude',
};

export const schedulerSettings = signal<SchedulerSettings>({ ...DEFAULT_SCHEDULER_SETTINGS });

// -- Agent Pool (derived from agents signal) --
export const agentPool = computed(() => {
  const pool = new Map<string, AgentPoolEntry>();
  for (const [id, agent] of agents.value) {
    if (agent.id.startsWith('slot-')) {
      pool.set(agent.id, {
        slotId: agent.id,
        status: agent.status === 'running' ? 'running' : 'idle',
        sessionId: agent.sessionId,
        assignedTaskId: agent.assignedTaskId,
        agentProviderId: agent.providerId,
        startedAt: agent.startedAt,
      });
    }
  }
  return pool;
});

// -- Task Queue (derived from tasks signal) --
export const taskQueue = computed(() => {
  const queue: TaskPoolEntry[] = [];
  for (const [, task] of tasks.value) {
    if (task.queueStatus !== 'none') {
      queue.push({
        taskId: task.id,
        status: task.queueStatus as TaskPoolEntry['status'],
        assignedSlotId: task.assignedAgentId,
        queuedAt: task.queuedAt ?? 0,
        dispatchedAt: task.dispatchedAt,
        completedAt: task.completedAt,
      });
    }
  }
  return queue.sort((a, b) => a.queuedAt - b.queuedAt);
});

// -- Agent providers --
export interface AgentProvider {
  id: string;
  name: string;
  command: string;
  color: string;
  isCustom?: boolean;
}

// -- Execution History --
export interface ExecutionRecord {
  id: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  taskTitle?: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed';
  outputPreview?: string; // First 500 chars of output
}

export const executionHistory = signal<ExecutionRecord[]>([]);
const MAX_HISTORY_ENTRIES = 100;

export function addExecutionRecord(record: Omit<ExecutionRecord, 'id'>) {
  const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newRecord: ExecutionRecord = { ...record, id };

  executionHistory.value = [newRecord, ...executionHistory.value].slice(0, MAX_HISTORY_ENTRIES);
  saveExecutionHistory();
}

export function updateExecutionRecord(id: string, updates: Partial<ExecutionRecord>) {
  executionHistory.value = executionHistory.value.map(r =>
    r.id === id ? { ...r, ...updates } : r
  );
  saveExecutionHistory();
}

export function clearExecutionHistory() {
  executionHistory.value = [];
  saveExecutionHistory();
}

function saveExecutionHistory() {
  try {
    localStorage.setItem('cove-execution-history', JSON.stringify(executionHistory.value));
  } catch (e) {
    console.error('Failed to save execution history:', e);
  }
}

export function loadExecutionHistory() {
  try {
    const saved = localStorage.getItem('cove-execution-history');
    if (saved) {
      executionHistory.value = JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load execution history:', e);
  }
}

export const BUILTIN_AGENTS: AgentProvider[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', color: '#cba6f7' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', color: '#f9e2af' },
  { id: 'copilot', name: 'Copilot CLI', command: 'gh copilot suggest', color: '#a6e3a1' },
];

// Custom agent providers (user-defined CC instances)
export const customAgents = signal<AgentProvider[]>([]);

// All available agents (builtin + custom)
export const allAgents = computed(() => [...BUILTIN_AGENTS, ...customAgents.value]);

// Currently active agent provider for new sessions
export const activeAgentId = signal<string>('claude');

export function addCustomAgent(agent: Omit<AgentProvider, 'isCustom'>) {
  const newAgent: AgentProvider = { ...agent, isCustom: true };
  customAgents.value = [...customAgents.value, newAgent];
  // Persist to localStorage
  saveCustomAgents();
}

export function removeCustomAgent(id: string) {
  customAgents.value = customAgents.value.filter(a => a.id !== id);
  if (activeAgentId.value === id) {
    activeAgentId.value = 'claude';
  }
  saveCustomAgents();
}

export function updateCustomAgent(id: string, updates: Partial<AgentProvider>) {
  customAgents.value = customAgents.value.map(a =>
    a.id === id ? { ...a, ...updates } : a
  );
  saveCustomAgents();
}

function saveCustomAgents() {
  try {
    localStorage.setItem('cove-custom-agents', JSON.stringify(customAgents.value));
  } catch (e) {
    console.error('Failed to save custom agents:', e);
  }
}

export function loadCustomAgents() {
  try {
    const saved = localStorage.getItem('cove-custom-agents');
    if (saved) {
      customAgents.value = JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load custom agents:', e);
  }
}

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
  // Plan mode support
  planMode?: boolean;
  planContent?: string;
  planFilePath?: string;
}

export const panes = signal<PaneState[]>([]);
export const focusedPaneId = signal<string | null>(null);
export const expandedPaneId = signal<string | null>(null);

// -- Popout panes (floating windows) --
export interface PopoutPane {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}
export const popoutPanes = signal<Map<string, PopoutPane>>(new Map());
let nextPopoutZIndex = 100;

function savePopoutPositions() {
  try {
    const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [id, p] of popoutPanes.value) {
      positions[id] = { x: p.x, y: p.y, width: p.width, height: p.height };
    }
    localStorage.setItem('nexus-popout-positions', JSON.stringify(positions));
  } catch {}
}

export function loadPopoutPositions() {
  try {
    const saved = localStorage.getItem('nexus-popout-positions');
    if (!saved) return;
    const positions = JSON.parse(saved) as Record<string, { x: number; y: number; width: number; height: number }>;
    const map = new Map<string, PopoutPane>();
    for (const [paneId, bounds] of Object.entries(positions)) {
      // Verify pane still exists
      if (panes.value.some(p => p.id === paneId)) {
        map.set(paneId, { paneId, ...bounds, zIndex: ++nextPopoutZIndex });
      }
    }
    if (map.size > 0) popoutPanes.value = map;
  } catch {}
}

export function popoutPane(paneId: string) {
  const existing = popoutPanes.value.get(paneId);
  if (existing) {
    // Bring to front
    const updated = { ...existing, zIndex: ++nextPopoutZIndex };
    popoutPanes.value = new Map(popoutPanes.value).set(paneId, updated);
    return;
  }

  // Create new popout at center
  const popout: PopoutPane = {
    paneId,
    x: Math.max(50, (window.innerWidth - 600) / 2),
    y: Math.max(50, (window.innerHeight - 500) / 2),
    width: 600,
    height: 500,
    zIndex: ++nextPopoutZIndex,
  };
  popoutPanes.value = new Map(popoutPanes.value).set(paneId, popout);
  savePopoutPositions();
}

export function closePopout(paneId: string) {
  const map = new Map(popoutPanes.value);
  map.delete(paneId);
  popoutPanes.value = map;
  savePopoutPositions();
}

export function updatePopout(paneId: string, updates: Partial<PopoutPane>) {
  const existing = popoutPanes.value.get(paneId);
  if (!existing) return;
  const updated = { ...existing, ...updates };
  popoutPanes.value = new Map(popoutPanes.value).set(paneId, updated);
  savePopoutPositions();
}

export function bringPopoutToFront(paneId: string) {
  const existing = popoutPanes.value.get(paneId);
  if (!existing) return;
  const updated = { ...existing, zIndex: ++nextPopoutZIndex };
  popoutPanes.value = new Map(popoutPanes.value).set(paneId, updated);
}

// -- Expanded pane helper --
export function expandPane(paneId: string | null) {
  expandedPaneId.value = paneId;
}

// -- Plan mode detection and management --
// Pattern to detect Claude Code entering plan mode (looks for plan mode indicators in terminal output)
const PLAN_MODE_START_PATTERN = /\[Plan Mode\]|Entering plan mode|Plan:/i;
const PLAN_MODE_END_PATTERN = /\[Exit Plan Mode\]|Exiting plan mode|Plan approved/i;

// Signal fired when an agent enters plan mode - app.tsx can watch this to show notifications
export interface PlanModeAlert {
  paneId: string;
  agentName: string;
  timestamp: number;
}
export const planModeAlert = signal<PlanModeAlert | null>(null);

// Call this when terminal receives data to check for plan mode transitions
export function detectPlanMode(sessionId: string, data: string) {
  const pane = panes.value.find(p => p.sessionId === sessionId);
  if (!pane || pane.kind !== 'agent') return;

  // Detect plan mode start
  if (!pane.planMode && PLAN_MODE_START_PATTERN.test(data)) {
    updatePane(pane.id, { planMode: true, planContent: '' });
    // Emit a plan notification event
    planModeAlert.value = {
      paneId: pane.id,
      agentName: pane.agentName ?? 'Agent',
      timestamp: Date.now(),
    };
  }

  // Accumulate plan content when in plan mode
  if (pane.planMode) {
    const current = pane.planContent ?? '';
    // Strip ANSI codes for readability
    const cleanData = data.replace(/\x1b\[[0-9;]*m/g, '');
    updatePane(pane.id, { planContent: current + cleanData });
  }

  // Detect plan mode end
  if (pane.planMode && PLAN_MODE_END_PATTERN.test(data)) {
    updatePane(pane.id, { planMode: false });
  }
}

// Approve a plan (send confirmation to the terminal)
export async function approvePlan(paneId: string) {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane?.sessionId) return;
  // Send 'y' to approve the plan
  await ipc.call('pty.write', { session_id: pane.sessionId, data: 'y\n' });
  updatePane(paneId, { planMode: false, planContent: undefined });
}

// Reject a plan (send rejection to the terminal)
export async function rejectPlan(paneId: string, feedback?: string) {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane?.sessionId) return;
  // Send 'n' to reject, optionally with feedback
  const response = feedback ? `n\n${feedback}\n` : 'n\n';
  await ipc.call('pty.write', { session_id: pane.sessionId, data: response });
  updatePane(paneId, { planMode: false, planContent: undefined });
}

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
  panes.value.filter(p =>
    p.spaceId === activeSpaceId.value &&
    !p.embedded &&
    p.id !== expandedPaneId.value &&
    !popoutPanes.value.has(p.id)
  )
);

export const activeSpaceNotes = computed(() =>
  notes.value.filter(n => n.spaceId === activeSpaceId.value)
);

// -- Task tree computed --
export const activeSpaceTasks = computed(() =>
  Array.from(tasks.value.values()).filter(t => t.spaceId === activeSpaceId.value)
);

export const activeSpaceRootTasks = computed(() =>
  activeSpaceTasks.value.filter(t => !t.parentTaskId)
);

export interface TaskTreeNode extends TaskEntity {
  children: TaskTreeNode[];
}

export const taskTree = computed(() => {
  const all = activeSpaceTasks.value;

  function buildTree(task: TaskEntity): TaskTreeNode {
    const children = all.filter(t => t.parentTaskId === task.id);
    return { ...task, children: children.map(buildTree) };
  }

  return activeSpaceRootTasks.value.map(buildTree);
});

// -- Agent Pool Computed (use new entities) --
export const activeSpaceAgents = computed(() =>
  Array.from(agents.value.values()).filter(a => a.spaceId === activeSpaceId.value)
);

export const idleSlots = computed(() =>
  Array.from(agentPool.value.values()).filter(s => s.status === 'idle')
);

export const runningAgentsCount = computed(() =>
  Array.from(agentPool.value.values()).filter(s => s.status === 'running').length
);

// -- Task Queue Computed (use new entities) --
export const queuedTasks = computed(() => {
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return taskQueue.value
    .filter(t => t.status === 'queued')
    .sort((a, b) => {
      const taskA = tasks.value.get(a.taskId);
      const taskB = tasks.value.get(b.taskId);
      const pa = priorityOrder[taskA?.priority ?? 'medium'];
      const pb = priorityOrder[taskB?.priority ?? 'medium'];
      if (pa !== pb) return pa - pb;
      return a.queuedAt - b.queuedAt;
    });
});

// -- Bidirectional Task ↔ Agent Lookups --

export function getAgentForTask(taskId: string): AgentEntity | null {
  const task = tasks.value.get(taskId);
  if (!task?.assignedAgentId) return null;
  return agents.value.get(task.assignedAgentId) ?? null;
}

export function getTaskForAgent(agentId: string): TaskEntity | null {
  const agent = agents.value.get(agentId);
  if (!agent?.assignedTaskId) return null;
  return tasks.value.get(agent.assignedTaskId) ?? null;
}

export function getSubtasks(taskId: string): TaskEntity[] {
  return Array.from(tasks.value.values()).filter(t => t.parentTaskId === taskId);
}

export function getTaskAncestors(taskId: string): TaskEntity[] {
  const ancestors: TaskEntity[] = [];
  let current = tasks.value.get(taskId);
  while (current?.parentTaskId) {
    const parent = tasks.value.get(current.parentTaskId);
    if (parent) {
      ancestors.unshift(parent);
      current = parent;
    } else break;
  }
  return ancestors;
}

// -- Agent Pool Management (now via backend) --

export async function initializeAgentPool(concurrency: number): Promise<void> {
  const space = activeSpace.value;
  if (!space) return;

  // Check if pool already exists
  const existingAgents = activeSpaceAgents.value.filter(a => a.id.startsWith('slot-'));
  if (existingAgents.length >= concurrency) return;

  // Create slots via backend
  await ipc.call('scheduler.initPool', {
    space_id: space.id,
    concurrency,
    provider_id: schedulerSettings.value.defaultAgentId,
    provider_name: BUILTIN_AGENTS.find(a => a.id === schedulerSettings.value.defaultAgentId)?.name ?? 'Claude Code',
  });

  // Refresh agents from backend
  const agentsList = await ipc.call<any[]>('agent.list', { space_id: space.id });
  const newAgents = new Map(agents.value);
  for (const a of agentsList) {
    newAgents.set(a.id, convertAgent(a));
  }
  agents.value = newAgents;
}

export async function resizeAgentPool(newSize: number): Promise<void> {
  // Update scheduler settings
  const wsId = currentWorkspaceId.value;
  if (!wsId) return;

  await ipc.call('scheduler.setSettings', {
    workspace_id: wsId,
    concurrency: newSize,
    auto_dispatch: schedulerSettings.value.autoDispatch,
    default_agent_id: schedulerSettings.value.defaultAgentId,
  });

  schedulerSettings.value = { ...schedulerSettings.value, concurrency: newSize };

  // Reinitialize pool if needed
  await initializeAgentPool(newSize);
}

// Helper to convert backend agent to frontend entity
function convertAgent(raw: any): AgentEntity {
  return {
    id: raw.id,
    spaceId: raw.space_id,
    providerId: raw.provider_id,
    providerName: raw.provider_name,
    status: raw.status,
    sessionId: raw.session_id,
    assignedTaskId: raw.assigned_task_id,
    prompt: raw.prompt,
    startedAt: raw.started_at,
    nodeId: raw.node_id,
    sortOrder: raw.sort_order ?? 0,
    createdAt: raw.created_at ?? Date.now(),
  };
}

// Helper to convert backend task to frontend entity
function convertTask(raw: any): TaskEntity {
  return {
    id: raw.id,
    spaceId: raw.space_id,
    parentTaskId: raw.parent_task_id,
    title: raw.title,
    description: raw.description,
    status: raw.status,
    priority: raw.priority,
    queueStatus: raw.queue_status,
    queuedAt: raw.queued_at,
    dispatchedAt: raw.dispatched_at,
    completedAt: raw.completed_at,
    assignedAgentId: raw.assigned_agent_id,
    nodeId: raw.node_id,
    sortOrder: raw.sort_order ?? 0,
    createdAt: raw.created_at ?? Date.now(),
  };
}

function normalizeSchedulerSettings(raw: any): SchedulerSettings {
  return {
    concurrency: Math.max(1, Number(raw?.concurrency ?? DEFAULT_SCHEDULER_SETTINGS.concurrency) || DEFAULT_SCHEDULER_SETTINGS.concurrency),
    autoDispatch: typeof raw?.auto_dispatch === 'boolean' ? raw.auto_dispatch : (raw?.autoDispatch ?? DEFAULT_SCHEDULER_SETTINGS.autoDispatch),
    defaultAgentId: raw?.default_agent_id ?? raw?.defaultAgentId ?? DEFAULT_SCHEDULER_SETTINGS.defaultAgentId,
  };
}

async function loadSchedulerSettings(workspaceId: string): Promise<void> {
  try {
    const settings = await ipc.call<any>('scheduler.getSettings', { workspace_id: workspaceId });
    schedulerSettings.value = normalizeSchedulerSettings(settings);
  } catch {
    schedulerSettings.value = { ...DEFAULT_SCHEDULER_SETTINGS };
  }
}

async function ensureWorkspace(): Promise<string | null> {
  if (currentWorkspaceId.value) return currentWorkspaceId.value;

  try {
    const created = await ipc.call<{ id: string }>('workspace.create', {
      name: 'Default',
      path: workspacePath.value,
    });
    currentWorkspaceId.value = created.id;
    await loadSchedulerSettings(created.id);
    return created.id;
  } catch (err) {
    console.error('workspace.create failed:', err);
    return null;
  }
}

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
  let space = activeSpace.value;
  if (!space) {
    space = await createSpace('Default');
  }
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
  const agent = allAgents.value.find(a => a.id === agentId) ?? BUILTIN_AGENTS.find(a => a.id === agentId);
  if (!agent) return null;

  // Launch interactive TUI
  const pane = await spawnTerminal('agent', agent.name, agent.command, prompt);

  // Record execution history
  if (pane) {
    addExecutionRecord({
      agentId: agent.id,
      agentName: agent.name,
      prompt,
      startedAt: Date.now(),
      status: 'running',
    });
  }

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

const BEST_OF_N_TITLE_MAX_LENGTH = 40;

// Best of N: run a task N times with different or same agents
export async function spawnBestOfN(taskPaneId: string, agentIds: string[], prompt: string): Promise<void> {
  const space = activeSpace.value;
  if (!space) return;

  for (let i = 0; i < agentIds.length; i++) {
    const agentId = agentIds[i];
    // Create a sub-task for each run
    const subTask = await createTask(
      `Run ${i + 1}: ${prompt.slice(0, BEST_OF_N_TITLE_MAX_LENGTH)}`,
      prompt,
      'medium',
      taskPaneId
    );
    if (subTask) {
      await spawnAgentForTask(subTask.id, agentId, prompt);
    }
  }
}

// Create task via backend (persisted)
export async function createTask(
  title: string,
  description: string,
  priority: 'low' | 'medium' | 'high' = 'medium',
  parentTaskId?: string
): Promise<TaskEntity | null> {
  let space = activeSpace.value;
  if (!space) {
    space = await createSpace('Default');
  }
  if (!space) return null;

  try {
    const result = await ipc.call<any>('task.create', {
      space_id: space.id,
      title,
      description,
      priority,
      parent_task_id: parentTaskId,
    });

    const task = convertTask(result);
    tasks.value = new Map(tasks.value).set(task.id, task);

    // Also create a pane for UI display
    const pane: PaneState = {
      id: task.id,
      kind: 'task',
      spaceId: space.id,
      taskTitle: title,
      taskDescription: description,
      taskStatus: 'todo',
      taskPriority: priority,
    };
    panes.value = [...panes.value, pane];
    focusedPaneId.value = pane.id;

    // Auto-enqueue if autoDispatch is enabled
    if (schedulerSettings.value.autoDispatch) {
      await enqueueTask(task.id);
    }

    return task;
  } catch (err) {
    console.error('task.create failed:', err);
    return null;
  }
}

// Legacy createTask for backward compatibility (creates pane only, not persisted entity)
export function createTaskPane(title: string, description: string, priority: 'low' | 'medium' | 'high' = 'medium'): PaneState | null {
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

// -- Task Queue Management (via backend) --

export async function enqueueTask(taskId: string): Promise<void> {
  try {
    await ipc.call('task.enqueue', { id: taskId });

    // Update local state
    const task = tasks.value.get(taskId);
    if (task) {
      const updated = { ...task, queueStatus: 'queued' as const, queuedAt: Date.now() };
      tasks.value = new Map(tasks.value).set(taskId, updated);
    }
  } catch (err) {
    console.error('task.enqueue failed:', err);
  }
}

// Assign task to agent (via backend with bidirectional update)
export async function assignTaskToAgent(taskId: string, agentId: string): Promise<void> {
  try {
    await ipc.call('task.assign', { task_id: taskId, agent_id: agentId });

    // Update local task
    const task = tasks.value.get(taskId);
    if (task) {
      const updatedTask = {
        ...task,
        assignedAgentId: agentId,
        queueStatus: 'dispatched' as const,
        dispatchedAt: Date.now(),
        status: 'doing' as const,
      };
      tasks.value = new Map(tasks.value).set(taskId, updatedTask);
    }

    // Update local agent
    const agent = agents.value.get(agentId);
    if (agent) {
      const updatedAgent = {
        ...agent,
        assignedTaskId: taskId,
        status: 'running' as const,
        startedAt: Date.now(),
      };
      agents.value = new Map(agents.value).set(agentId, updatedAgent);
    }
  } catch (err) {
    console.error('task.assign failed:', err);
  }
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
  // 1. Update pane status
  panes.value = panes.value.map(p =>
    p.sessionId === sessionId ? { ...p, sessionStatus: 'exited' as const } : p
  );

  // 2. Handle agent pool completion
  handleAgentCompletion(sessionId);
}

function handleAgentCompletion(sessionId: string): void {
  // Find the slot that had this session
  const pool = agentPool.value;
  let completedSlot: AgentPoolEntry | null = null;

  for (const [, slot] of pool) {
    if (slot.sessionId === sessionId) {
      completedSlot = slot;
      break;
    }
  }

  if (!completedSlot) return;

  // Update task queue entry to completed
  if (completedSlot.assignedTaskId) {
    taskQueue.value = taskQueue.value.map(t =>
      t.taskId === completedSlot!.assignedTaskId
        ? { ...t, status: 'completed' as const, completedAt: Date.now() }
        : t
    );

    // Update task pane status to done
    updatePane(completedSlot.assignedTaskId, { taskStatus: 'done' });
  }

  // Reset slot to idle (effect will auto-dispatch next task)
  const newPool = new Map(agentPool.value);
  newPool.set(completedSlot.slotId, {
    slotId: completedSlot.slotId,
    status: 'idle',
    agentProviderId: completedSlot.agentProviderId,
  });
  agentPool.value = newPool;
}

// -- Workspace Path (default working directory) --

export async function setWorkspacePath(path: string): Promise<void> {
  const wsId = await ensureWorkspace();
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

export async function createSpace(name: string, id?: string): Promise<SpaceState | null> {
  const workspaceId = await ensureWorkspace();
  if (!workspaceId) return null;

  try {
    const created = await ipc.call<{ id: string }>('space.create', {
      workspace_id: workspaceId,
      name,
      id,
    });
    const space = { id: created.id, name };
    spaces.value = [...spaces.value, space];
    activeSpaceId.value = space.id;
    return space;
  } catch (err) {
    console.error('space.create failed:', err);
    return null;
  }
}

export function getLinkedPane(paneId: string): PaneState | undefined {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane?.linkedPaneId) return undefined;
  return panes.value.find(p => p.id === pane.linkedPaneId);
}

// -- Bidirectional Task ↔ Agent Lookups --

export function getAssignedAgent(taskId: string): AgentPoolEntry | null {
  for (const slot of agentPool.value.values()) {
    if (slot.assignedTaskId === taskId) {
      return slot;
    }
  }
  return null;
}

export function getAssignedTask(slotId: string): PaneState | null {
  const slot = agentPool.value.get(slotId);
  if (!slot?.assignedTaskId) return null;
  return panes.value.find(p => p.id === slot.assignedTaskId) ?? null;
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

interface HydratedTask {
  id: string;
  space_id: string;
  parent_task_id?: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  queue_status: string;
  queued_at?: number;
  dispatched_at?: number;
  completed_at?: number;
  assigned_agent_id?: string;
  created_at: number;
}

interface HydratedAgent {
  id: string;
  space_id: string;
  provider_id: string;
  provider_name: string;
  status: string;
  session_id?: string;
  assigned_task_id?: string;
  started_at?: number;
  created_at: number;
}

interface HydratedSpace {
  id: string;
  workspace_id: string;
  name: string;
  nodes: HydratedNode[];
  tasks?: HydratedTask[];
  agents?: HydratedAgent[];
}

interface HydratedWorkspace {
  id: string;
  name: string;
  path?: string;
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
      const restoredTasks = new Map<string, TaskEntity>();
      const restoredAgents = new Map<string, AgentEntity>();
      currentWorkspaceId.value = ws.id;
      await loadSchedulerSettings(ws.id);

      // Restore workspace path (default cwd)
      workspacePath.value = ws.path || '';

      for (const sp of ws.spaces) {
        restoredSpaces.push({ id: sp.id, name: sp.name });

        // Restore tasks from new tables
        for (const t of sp.tasks ?? []) {
          restoredTasks.set(t.id, convertTask(t));

          // Create pane for task UI
          restoredPanes.push({
            id: t.id,
            kind: 'task',
            spaceId: sp.id,
            taskTitle: t.title,
            taskDescription: t.description,
            taskStatus: t.status as PaneState['taskStatus'],
            taskPriority: t.priority as PaneState['taskPriority'],
          });
        }

        // Restore agents from new tables
        for (const a of sp.agents ?? []) {
          restoredAgents.set(a.id, convertAgent(a));
        }

        // Also restore legacy nodes (for backward compatibility)
        for (const node of sp.nodes ?? []) {
          // Skip if already added as task
          if (restoredPanes.some(p => p.id === node.id)) continue;

          const pane: PaneState = {
            id: node.id,
            kind: node.kind as PaneKind,
            spaceId: sp.id,
            sessionId: undefined,
            sessionStatus: 'exited',
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
        tasks.value = restoredTasks;
        agents.value = restoredAgents;
        activeSpaceId.value = restoredSpaces[0].id;

        // Use workspace path for spawning, or default
        const cwd = ws.path || undefined;

        // Re-spawn PTY sessions ONLY for slot-based pool agents (background slots)
        // Individual task/agent panes should be re-dispatched by user or auto-dispatch
        for (const pane of restoredPanes) {
          // Only spawn shell-kind panes that were actively running
          if (pane.kind === 'shell') {
            try {
              const resp = await ipc.call<{ session_id: string }>('pty.spawn', {
                cwd,
                kind: 'shell',
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
    await ensureWorkspace();
    await createSpace('Default');
  } catch (err) {
    console.error('hydrateState failed:', err);
    await ensureWorkspace();
    await createSpace('Default');
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

export interface ExportedWorkspace {
  version: 1;
  exportedAt: number;
  workspace: {
    id: string;
    path: string;
  };
  spaces: Array<{
    id: string;
    name: string;
  }>;
  tasks: TaskEntity[];
  agents: AgentEntity[];
  notes: NoteState[];
  schedulerSettings: SchedulerSettings;
}

// Export current workspace state to JSON (frontend-only, doesn't require backend)
export function exportWorkspaceToJson(): string {
  const wsId = currentWorkspaceId.value || 'unknown';
  const exported: ExportedWorkspace = {
    version: 1,
    exportedAt: Date.now(),
    workspace: {
      id: wsId,
      path: workspacePath.value,
    },
    spaces: spaces.value,
    tasks: Array.from(tasks.value.values()),
    agents: Array.from(agents.value.values()),
    notes: notes.value,
    schedulerSettings: schedulerSettings.value,
  };
  return JSON.stringify(exported, null, 2);
}

function normalizeImportedTask(task: TaskEntity) {
  if (task.status === 'done' || task.queueStatus === 'completed') {
    return { status: 'done' as const, queueStatus: 'completed' as const };
  }

  if (task.queueStatus === 'queued' || task.queueStatus === 'dispatched' || task.status === 'doing') {
    return { status: 'todo' as const, queueStatus: 'queued' as const };
  }

  return { status: 'todo' as const, queueStatus: 'none' as const };
}

async function clearCurrentWorkspaceState(): Promise<void> {
  const existingSpaces = [...spaces.value];
  for (const space of existingSpaces) {
    await ipc.call('space.delete', { id: space.id });
  }

  spaces.value = [];
  panes.value = [];
  tasks.value = new Map();
  agents.value = new Map();
  notes.value = [];
  focusedPaneId.value = null;
  expandedPaneId.value = null;
  popoutPanes.value = new Map();
}

// Import workspace state from JSON (frontend-only)
export async function importWorkspaceFromJson(json: string): Promise<void> {
  const data = JSON.parse(json) as ExportedWorkspace;

  if (data.version !== 1) {
    throw new Error(`Unsupported export version: ${data.version}`);
  }

  const workspaceId = await ensureWorkspace();
  if (!workspaceId) {
    throw new Error('No workspace available');
  }

  await clearCurrentWorkspaceState();
  await setWorkspacePath(data.workspace.path ?? '');

  const importedSettings = normalizeSchedulerSettings(data.schedulerSettings);
  await ipc.call('scheduler.setSettings', {
    workspace_id: workspaceId,
    concurrency: importedSettings.concurrency,
    auto_dispatch: importedSettings.autoDispatch,
    default_agent_id: importedSettings.defaultAgentId,
  });
  schedulerSettings.value = importedSettings;

  const spaceIdMap = new Map<string, string>();
  for (const space of data.spaces) {
    const created = await createSpace(space.name, space.id);
    if (created) {
      spaceIdMap.set(space.id, created.id);
    }
  }

  if (spaceIdMap.size === 0) {
    const fallback = await createSpace('Default');
    if (fallback) {
      spaceIdMap.set('default', fallback.id);
    }
  }

  const taskIdMap = new Map<string, string>();
  const pendingTasks = [...data.tasks];
  while (pendingTasks.length > 0) {
    let progressed = false;

    for (let i = 0; i < pendingTasks.length; i++) {
      const task = pendingTasks[i];
      const mappedSpaceId = spaceIdMap.get(task.spaceId) ?? activeSpaceId.value;
      const mappedParentTaskId = task.parentTaskId ? taskIdMap.get(task.parentTaskId) : undefined;

      if (task.parentTaskId && !mappedParentTaskId) continue;
      if (!mappedSpaceId) continue;

      const created = await ipc.call<any>('task.create', {
        id: task.id,
        space_id: mappedSpaceId,
        title: task.title,
        description: task.description,
        priority: task.priority,
        parent_task_id: mappedParentTaskId,
      });

      const createdId = created.id ?? task.id;
      taskIdMap.set(task.id, createdId);

      const normalized = normalizeImportedTask(task);
      if (normalized.status !== 'todo' || normalized.queueStatus !== 'none') {
        await ipc.call('task.update', {
          id: createdId,
          status: normalized.status,
          queue_status: normalized.queueStatus,
        });
      }

      pendingTasks.splice(i, 1);
      i--;
      progressed = true;
    }

    if (!progressed) {
      throw new Error('Could not resolve imported task hierarchy');
    }
  }

  notes.value = data.notes.map(note => ({
    ...note,
    spaceId: spaceIdMap.get(note.spaceId) ?? activeSpaceId.value ?? note.spaceId,
    linkedPaneId: note.linkedPaneId ? taskIdMap.get(note.linkedPaneId) : undefined,
  }));

  await hydrateState();
}

// Backend-backed export (full persistence)
export async function exportWorkspace(workspaceId: string): Promise<string> {
  void workspaceId;
  return exportWorkspaceToJson();
}

export async function importWorkspace(json: string): Promise<void> {
  await importWorkspaceFromJson(json);
}

// -- Auto dispatch effect (Pool-based, now with backend persistence) --

// Track dispatching state to prevent duplicate dispatches
let isDispatching = false;

async function dispatchTaskToSlot(taskId: string, slotId: string): Promise<void> {
  const slot = agentPool.value.get(slotId);
  if (!slot || slot.status !== 'idle') return;

  const task = tasks.value.get(taskId);
  if (!task) return;

  const agentProviderId = schedulerSettings.value.defaultAgentId || slot.agentProviderId;
  const prompt = task.description || task.title;

  // 1. Assign task to agent via backend (handles bidirectional update)
  await assignTaskToAgent(taskId, slotId);

  // 2. Spawn fresh agent process
  const agentPane = await spawnAgent(agentProviderId, prompt);

  if (agentPane?.sessionId) {
    // 3. Update agent entity with session ID
    const agent = agents.value.get(slotId);
    if (agent) {
      const updated = { ...agent, sessionId: agentPane.sessionId };
      agents.value = new Map(agents.value).set(slotId, updated);

      // Also update backend
      await ipc.call('agent.update', { id: slotId, session_id: agentPane.sessionId }).catch(() => {});
    }

    // 4. Link agent pane to task (embedded)
    updatePane(agentPane.id, { embedded: true });
    linkPane(taskId, agentPane.id);
    updatePane(taskId, { taskStatus: 'doing' });
  }
}

effect(() => {
  const settings = schedulerSettings.value;
  if (!settings.autoDispatch) return;
  if (isDispatching) return;

  const idle = idleSlots.value;
  const queued = queuedTasks.value;

  if (idle.length > 0 && queued.length > 0) {
    isDispatching = true;

    // Dispatch tasks to available slots
    const dispatchCount = Math.min(idle.length, queued.length);
    const dispatches: Promise<void>[] = [];

    for (let i = 0; i < dispatchCount; i++) {
      dispatches.push(dispatchTaskToSlot(queued[i].taskId, idle[i].slotId));
    }

    Promise.all(dispatches).finally(() => {
      isDispatching = false;
    });
  }
});
