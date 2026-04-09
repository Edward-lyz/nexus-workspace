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

interface SchedulerDispatchAssignment {
  task_id: string;
  agent_id: string;
}

interface SchedulerSessionExitResult {
  kind: 'none' | 'slot' | 'standalone';
  space_id?: string;
  task_id?: string;
  agent_id?: string;
  task_status?: TaskEntity['status'];
  queue_status?: TaskEntity['queueStatus'];
  agent_status?: AgentEntity['status'];
}

interface SchedulerStopTaskResult {
  space_id: string;
  task_id: string;
  task_status: TaskEntity['status'];
  queue_status: TaskEntity['queueStatus'];
  agent_id?: string;
  session_id?: string;
  agent_status?: AgentEntity['status'];
}

interface SchedulerAttachTaskSessionResult {
  space_id: string;
  task_id: string;
  agent_id: string;
  session_id: string;
  agent_status?: AgentEntity['status'];
}

const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  concurrency: 4,
  autoDispatch: true,
  defaultAgentId: 'claude',
};

const SLOT_ID_PREFIX = 'slot-';

function getSlotIndex(agentId?: string): number | null {
  if (!agentId?.startsWith(SLOT_ID_PREFIX)) return null;
  const index = Number.parseInt(agentId.slice(SLOT_ID_PREFIX.length), 10);
  return Number.isFinite(index) && index > 0 ? index : null;
}

export const schedulerSettings = signal<SchedulerSettings>({ ...DEFAULT_SCHEDULER_SETTINGS });

// -- Agent Pool (derived from agents signal) --
export const agentPool = computed(() => {
  const pool = new Map<string, AgentPoolEntry>();
  const activeId = activeSpaceId.value;
  for (const [id, agent] of agents.value) {
    const slotIndex = getSlotIndex(agent.id);
    const shouldInclude = slotIndex !== null
      && agent.spaceId === activeId
      && (
        slotIndex <= schedulerSettings.value.concurrency
        || agent.status === 'running'
        || Boolean(agent.assignedTaskId)
        || Boolean(agent.sessionId)
      );
    if (shouldInclude) {
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
  const activeId = activeSpaceId.value;
  for (const [, task] of tasks.value) {
    if (task.spaceId === activeId && task.queueStatus !== 'none') {
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
let workspaceUiStateReady = false;

const WORKSPACE_SETTING_KEYS = {
  executionHistory: 'frontend.executionHistory',
  customAgents: 'frontend.customAgents',
  layoutMode: 'frontend.layoutMode',
  notes: 'frontend.notes',
  archivedPanes: 'frontend.archivedPanes',
  activeSpaceId: 'frontend.activeSpaceId',
  focusedPaneId: 'frontend.focusedPaneId',
} as const;

async function getWorkspaceSetting<T>(key: string): Promise<T | null> {
  if (!currentWorkspaceId.value) return null;
  try {
    return await ipc.call<T | null>('settings.get', { key });
  } catch {
    return null;
  }
}

function setWorkspaceSetting(key: string, value: unknown): void {
  if (!workspaceUiStateReady || !currentWorkspaceId.value) return;
  void ipc.call('settings.set', {
    key,
    value: JSON.stringify(value),
  }).catch(() => {});
}

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
    if (typeof globalThis.localStorage?.setItem !== 'function') return;
    localStorage.setItem('nexus-execution-history', JSON.stringify(executionHistory.value));
  } catch (e) {
    console.error('Failed to save execution history:', e);
  }
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.executionHistory, executionHistory.value);
}

export async function loadExecutionHistory() {
  const savedFromDb = await getWorkspaceSetting<ExecutionRecord[]>(WORKSPACE_SETTING_KEYS.executionHistory);
  if (savedFromDb) {
    executionHistory.value = savedFromDb;
    return;
  }
  try {
    if (typeof globalThis.localStorage?.getItem !== 'function') return;
    const saved = localStorage.getItem('nexus-execution-history');
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
  { id: 'copilot', name: 'Copilot CLI', command: 'gh copilot', color: '#a6e3a1' },
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
    if (typeof globalThis.localStorage?.setItem !== 'function') return;
    localStorage.setItem('nexus-custom-agents', JSON.stringify(customAgents.value));
  } catch (e) {
    console.error('Failed to save custom agents:', e);
  }
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.customAgents, customAgents.value);
}

export async function loadCustomAgents() {
  const savedFromDb = await getWorkspaceSetting<AgentProvider[]>(WORKSPACE_SETTING_KEYS.customAgents);
  if (savedFromDb) {
    customAgents.value = savedFromDb;
    return;
  }
  try {
    if (typeof globalThis.localStorage?.getItem !== 'function') return;
    const saved = localStorage.getItem('nexus-custom-agents');
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
  sessionStatus?: 'pending' | 'running' | 'idle' | 'exited';
  lastActivityAt?: number;
  taskTitle?: string;
  taskDescription?: string;
  taskStatus?: 'todo' | 'doing' | 'done';
  taskPriority?: 'low' | 'medium' | 'high';
  linkedPaneId?: string;
  embedded?: boolean; // agent/shell spawned inline inside a task pane
  needsAttention?: boolean;
  archived?: boolean;
  archivedAt?: number;
  // Plan mode support
  planMode?: boolean;
  planContent?: string;
  planFilePath?: string;
}

export const panes = signal<PaneState[]>([]);
export const archivedPanes = signal<PaneState[]>([]);
export const focusedPaneId = signal<string | null>(null);
export const expandedPaneId = signal<string | null>(null);
export const layoutMode = signal<'horizontal' | 'vertical'>('horizontal');

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
    if (typeof globalThis.localStorage?.setItem !== 'function') return;
    const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [id, p] of popoutPanes.value) {
      positions[id] = { x: p.x, y: p.y, width: p.width, height: p.height };
    }
    localStorage.setItem('nexus-popout-positions', JSON.stringify(positions));
  } catch {}
}

export function loadPopoutPositions() {
  try {
    if (typeof globalThis.localStorage?.getItem !== 'function') return;
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

function saveLayoutMode() {
  try {
    if (typeof globalThis.localStorage?.setItem !== 'function') return;
    localStorage.setItem('nexus-layout-mode', layoutMode.value);
  } catch {}
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.layoutMode, layoutMode.value);
}

export async function loadLayoutMode() {
  const savedFromDb = await getWorkspaceSetting<'horizontal' | 'vertical'>(WORKSPACE_SETTING_KEYS.layoutMode);
  if (savedFromDb === 'horizontal' || savedFromDb === 'vertical') {
    layoutMode.value = savedFromDb;
    return;
  }
  try {
    if (typeof globalThis.localStorage?.getItem !== 'function') return;
    const saved = localStorage.getItem('nexus-layout-mode');
    if (saved === 'horizontal' || saved === 'vertical') {
      layoutMode.value = saved;
    }
  } catch {}
}

export function setLayoutMode(mode: 'horizontal' | 'vertical') {
  layoutMode.value = mode;
  saveLayoutMode();
}

export async function loadWorkspaceUiState() {
  workspaceUiStateReady = false;

  await Promise.all([
    loadCustomAgents(),
    loadExecutionHistory(),
    loadLayoutMode(),
  ]);

  const [savedNotes, savedArchivedPanes, savedActiveSpaceId, savedFocusedPaneId] = await Promise.all([
    getWorkspaceSetting<NoteState[]>(WORKSPACE_SETTING_KEYS.notes),
    getWorkspaceSetting<PaneState[]>(WORKSPACE_SETTING_KEYS.archivedPanes),
    getWorkspaceSetting<string>(WORKSPACE_SETTING_KEYS.activeSpaceId),
    getWorkspaceSetting<string>(WORKSPACE_SETTING_KEYS.focusedPaneId),
  ]);

  notes.value = savedNotes ?? [];

  if (savedArchivedPanes) {
    const archivedIds = new Set(savedArchivedPanes.map((pane) => pane.id));
    const activeById = new Map(panes.value.map((pane) => [pane.id, pane] as const));
    const restoredArchived = savedArchivedPanes.map((pane) => {
      const active = activeById.get(pane.id);
      if (active) {
        activeById.delete(pane.id);
        return {
          ...active,
          ...pane,
          archived: true,
          archivedAt: pane.archivedAt ?? Date.now(),
        };
      }
      return { ...pane, archived: true };
    });

    panes.value = panes.value.filter((pane) => !archivedIds.has(pane.id));
    archivedPanes.value = restoredArchived;
  } else {
    archivedPanes.value = [];
  }

  if (savedActiveSpaceId && spaces.value.some((space) => space.id === savedActiveSpaceId)) {
    activeSpaceId.value = savedActiveSpaceId;
  }

  if (savedFocusedPaneId) {
    focusedPaneId.value = panes.value.some((pane) => pane.id === savedFocusedPaneId)
      ? savedFocusedPaneId
      : null;
  }

  workspaceUiStateReady = true;
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
const ATTENTION_PATTERN = /requires approval|approve|approval needed|permission|confirm|allow this|plan ready/i;
const SESSION_IDLE_MS = 5000;
const sessionIdleTimers = new Map<string, number>();

// Signal fired when an agent enters plan mode - app.tsx can watch this to show notifications
export interface PlanModeAlert {
  paneId: string;
  agentName: string;
  timestamp: number;
}
export const planModeAlert = signal<PlanModeAlert | null>(null);

export function bringPaneToFront(paneId: string) {
  const pane = panes.value.find((entry) => entry.id === paneId);
  if (!pane) return;
  panes.value = [
    ...panes.value.filter((entry) => entry.id !== paneId),
    pane,
  ];
  focusedPaneId.value = paneId;
}

export function clearPaneAttention(paneId: string) {
  updatePane(paneId, { needsAttention: false });
}

// Signal to trigger one-time shake animation on a pane
// Components should clear this after playing the animation
export const shakeOncePaneId = signal<string | null>(null);

export function triggerPaneShake(paneId: string) {
  shakeOncePaneId.value = paneId;
  // Auto-clear after animation duration (420ms)
  setTimeout(() => {
    if (shakeOncePaneId.value === paneId) {
      shakeOncePaneId.value = null;
    }
  }, 450);
}

function scheduleIdleTransition(sessionId: string) {
  const existing = sessionIdleTimers.get(sessionId);
  if (existing) {
    window.clearTimeout(existing);
  }
  const timer = window.setTimeout(() => {
    const pane = panes.value.find((entry) => entry.sessionId === sessionId);
    if (!pane || pane.sessionStatus !== 'running') return;
    updatePane(pane.id, { sessionStatus: 'idle' });
    sessionIdleTimers.delete(sessionId);
  }, SESSION_IDLE_MS);
  sessionIdleTimers.set(sessionId, timer);
}

export function markSessionActivity(sessionId: string, data?: string) {
  const pane = panes.value.find((entry) => entry.sessionId === sessionId);
  if (!pane) return;

  const needsAttention = Boolean(data && ATTENTION_PATTERN.test(data));
  updatePane(pane.id, {
    sessionStatus: 'running',
    lastActivityAt: Date.now(),
    needsAttention: needsAttention || pane.needsAttention,
  });

  if (needsAttention) {
    bringPaneToFront(pane.id);
  }

  scheduleIdleTransition(sessionId);
}

// Call this when terminal receives data to check for plan mode transitions
export function detectPlanMode(sessionId: string, data: string) {
  const pane = panes.value.find(p => p.sessionId === sessionId);
  if (!pane || pane.kind !== 'agent') return;

  // Detect plan mode start
  if (!pane.planMode && PLAN_MODE_START_PATTERN.test(data)) {
    updatePane(pane.id, { planMode: true, planContent: '', needsAttention: true });
    bringPaneToFront(pane.id);
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
    updatePane(pane.id, { planMode: false, needsAttention: false });
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
  panes.value.filter(p => p.spaceId === activeSpaceId.value && !p.archived)
);

// Only non-embedded panes go into the tiling grid
export const activeSpaceGridPanes = computed(() =>
  panes.value.filter(p =>
    p.spaceId === activeSpaceId.value &&
    !p.archived &&
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

effect(() => {
  if (!workspaceUiStateReady) return;
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.notes, notes.value);
});

effect(() => {
  if (!workspaceUiStateReady) return;
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.archivedPanes, archivedPanes.value);
});

effect(() => {
  if (!workspaceUiStateReady) return;
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.activeSpaceId, activeSpaceId.value);
});

effect(() => {
  if (!workspaceUiStateReady) return;
  setWorkspaceSetting(WORKSPACE_SETTING_KEYS.focusedPaneId, focusedPaneId.value);
});

export const idleSlots = computed(() =>
  Array.from(agentPool.value.values()).filter(s => s.status === 'idle')
);

export const runningSlotsCount = computed(() =>
  Array.from(agentPool.value.values()).filter(s => s.status === 'running').length
);

export const activeSessionsCount = computed(() =>
  panes.value.filter(
    (pane) =>
      (pane.kind === 'agent' || pane.kind === 'shell')
      && pane.sessionStatus === 'running'
      && Boolean(pane.sessionId),
  ).length
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

function isSlotAgentId(agentId?: string): agentId is string {
  return Boolean(agentId?.startsWith(SLOT_ID_PREFIX));
}

async function pruneExcessIdleSlots(spaceId: string, limit = schedulerSettings.value.concurrency): Promise<void> {
  const excessSlots = Array.from(agents.value.values()).filter((agent) => {
    const slotIndex = getSlotIndex(agent.id);
    return slotIndex !== null
      && agent.spaceId === spaceId
      && slotIndex > limit
      && agent.status !== 'running'
      && !agent.assignedTaskId
      && !agent.sessionId;
  });

  if (excessSlots.length === 0) return;

  const updatedAgents = new Map(agents.value);
  for (const slot of excessSlots) {
    updatedAgents.delete(slot.id);
  }
  agents.value = updatedAgents;

  await Promise.all(excessSlots.map((slot) =>
    ipc.call('agent.delete', { id: slot.id }).catch((err) => {
      console.error('agent.delete failed:', err);
    }),
  ));
}

// -- Agent Pool Management (now via backend) --

export async function initializeAgentPool(concurrency: number): Promise<void> {
  const space = activeSpace.value;
  if (!space) {
    return;
  }

  // Always refresh agents from backend first
  const agentsList = await ipc.call<any[]>('agent.list', { space_id: space.id });
  const existingSlots = agentsList.filter((a: any) => a.id.startsWith(SLOT_ID_PREFIX));
  const existingSlotIds = new Set(existingSlots.map((agent: any) => agent.id));

  let needsInit = false;
  for (let i = 1; i <= concurrency; i += 1) {
    if (!existingSlotIds.has(`${SLOT_ID_PREFIX}${i}`)) {
      needsInit = true;
      break;
    }
  }

  if (needsInit) {
    await ipc.call('scheduler.initPool', {
      space_id: space.id,
      concurrency,
      provider_id: schedulerSettings.value.defaultAgentId,
      provider_name: BUILTIN_AGENTS.find(a => a.id === schedulerSettings.value.defaultAgentId)?.name ?? 'Claude Code',
    });
  }

  const refreshedAgents = await ipc.call<any[]>('agent.list', { space_id: space.id });
  const newAgents = new Map(agents.value);
  for (const [id, agent] of newAgents) {
    if (agent.spaceId === space.id) {
      newAgents.delete(id);
    }
  }
  for (const a of refreshedAgents) {
    newAgents.set(a.id, convertAgent(a));
  }
  agents.value = newAgents;

  await pruneExcessIdleSlots(space.id, concurrency);
  await reconcileStaleDispatchState(space.id);
  await runSchedulerDispatch(space.id);
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

function updateTaskPaneFromEntity(task: TaskEntity): void {
  updatePane(task.id, {
    taskTitle: task.title,
    taskDescription: task.description,
    taskStatus: task.status,
    taskPriority: task.priority,
  });
}

function applyTaskEntity(taskId: string, updater: (task: TaskEntity) => TaskEntity): TaskEntity | null {
  const task = tasks.value.get(taskId);
  if (!task) return null;
  const updated = updater(task);
  tasks.value = new Map(tasks.value).set(taskId, updated);
  updateTaskPaneFromEntity(updated);
  return updated;
}

async function refreshSpaceEntities(spaceId: string): Promise<void> {
  const [tasksList, agentsList] = await Promise.all([
    ipc.call<any[]>('task.list', { space_id: spaceId }),
    ipc.call<any[]>('agent.list', { space_id: spaceId }),
  ]);

  const refreshedTasks = new Map(tasks.value);
  for (const [id, task] of refreshedTasks) {
    if (task.spaceId === spaceId) {
      refreshedTasks.delete(id);
    }
  }
  for (const rawTask of tasksList) {
    const task = convertTask(rawTask);
    refreshedTasks.set(task.id, task);
    updateTaskPaneFromEntity(task);
  }
  tasks.value = refreshedTasks;

  const refreshedAgents = new Map(agents.value);
  for (const [id, agent] of refreshedAgents) {
    if (agent.spaceId === spaceId) {
      refreshedAgents.delete(id);
    }
  }
  for (const rawAgent of agentsList) {
    const agent = convertAgent(rawAgent);
    refreshedAgents.set(agent.id, agent);
  }
  agents.value = refreshedAgents;
}

function setTaskDispatchLocal(taskId: string, requeue: boolean): void {
  applyTaskEntity(taskId, (task) => ({
    ...task,
    status: 'todo',
    queueStatus: requeue ? 'queued' : 'none',
    queuedAt: requeue ? Date.now() : undefined,
    dispatchedAt: undefined,
    completedAt: undefined,
    assignedAgentId: undefined,
  }));
}

function completeTaskLocal(taskId: string): void {
  applyTaskEntity(taskId, (task) => ({
    ...task,
    status: 'done',
    queueStatus: 'completed',
    completedAt: Date.now(),
    assignedAgentId: undefined,
  }));
}

function clearAgentAssignmentLocal(agentId: string, status: AgentEntity['status'], clearSessionId = false): void {
  const agent = agents.value.get(agentId);
  if (!agent) return;
  agents.value = new Map(agents.value).set(agentId, {
    ...agent,
    status,
    assignedTaskId: undefined,
    startedAt: undefined,
    sessionId: clearSessionId ? undefined : agent.sessionId,
  });
}

function setTaskAssignmentLocal(taskId: string, agentId: string): void {
  applyTaskEntity(taskId, (task) => ({
    ...task,
    assignedAgentId: agentId,
    queueStatus: 'dispatched',
    dispatchedAt: Date.now(),
    status: 'doing',
  }));

  const agent = agents.value.get(agentId);
  if (!agent) return;
  agents.value = new Map(agents.value).set(agentId, {
    ...agent,
    assignedTaskId: taskId,
    status: 'running',
    startedAt: Date.now(),
  });
}

let isSchedulerDispatchRunning = false;
let scheduleDispatchRerunRequested = false;

async function runSchedulerDispatch(spaceId = activeSpaceId.value): Promise<void> {
  if (!spaceId || !schedulerSettings.value.autoDispatch) return;

  if (isSchedulerDispatchRunning) {
    scheduleDispatchRerunRequested = true;
    return;
  }

  isSchedulerDispatchRunning = true;

  try {
    while (true) {
      const assignments = await ipc.call<SchedulerDispatchAssignment[]>('scheduler.dispatch', {
        space_id: spaceId,
      });

      if (!assignments.length) break;

      for (const assignment of assignments) {
        setTaskAssignmentLocal(assignment.task_id, assignment.agent_id);
        await startAssignedTask(assignment.task_id, assignment.agent_id);
      }

      if (!scheduleDispatchRerunRequested) break;
      scheduleDispatchRerunRequested = false;
    }
  } catch (err) {
    console.error('scheduler.dispatch failed:', err);
  } finally {
    isSchedulerDispatchRunning = false;
    if (scheduleDispatchRerunRequested) {
      scheduleDispatchRerunRequested = false;
      queueMicrotask(() => {
        void runSchedulerDispatch(spaceId);
      });
    }
  }
}

async function stopTaskExecution(taskId: string, requeue = schedulerSettings.value.autoDispatch): Promise<void> {
  try {
    const result = await ipc.call<SchedulerStopTaskResult>('scheduler.stopTask', { task_id: taskId, requeue });

    if (result.agent_id) {
      clearAgentAssignmentLocal(result.agent_id, result.agent_status ?? 'idle', true);
    }
    setTaskDispatchLocal(taskId, requeue);
  } catch (err) {
    console.error('scheduler.stopTask failed:', err);
    return;
  }

  const task = tasks.value.get(taskId);
  if (requeue && task) {
    await runSchedulerDispatch(task.spaceId);
  }
}

async function reconcileStaleDispatchState(spaceId = activeSpaceId.value): Promise<void> {
  if (!spaceId) return;

  try {
    await ipc.call('scheduler.reconcileSpace', {
      space_id: spaceId,
      requeue: schedulerSettings.value.autoDispatch,
    });
    await refreshSpaceEntities(spaceId);
  } catch (err) {
    console.error('scheduler.reconcileSpace failed:', err);
  }
}

function normalizeSchedulerSettings(raw: any): SchedulerSettings {
  const source = raw ?? {};
  const concurrency = Number(source.concurrency);
  const normalizedConcurrency = Number.isFinite(concurrency) ? concurrency : DEFAULT_SCHEDULER_SETTINGS.concurrency;
  const normalizedAutoDispatch = typeof source.auto_dispatch === 'boolean'
    ? source.auto_dispatch
    : (typeof source.autoDispatch === 'boolean' ? source.autoDispatch : DEFAULT_SCHEDULER_SETTINGS.autoDispatch);
  return {
    concurrency: Math.max(1, normalizedConcurrency),
    autoDispatch: normalizedAutoDispatch,
    defaultAgentId: source.default_agent_id ?? source.defaultAgentId ?? DEFAULT_SCHEDULER_SETTINGS.defaultAgentId,
  };
}

export async function loadSchedulerSettings(workspaceId: string): Promise<void> {
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

function resolveAgentDefinition(agentId: string) {
  return allAgents.value.find((agent) => agent.id === agentId) ?? BUILTIN_AGENTS.find((agent) => agent.id === agentId) ?? null;
}

function resolveAgentIdFromPane(pane: PaneState): string {
  if (!pane.agentName) return schedulerSettings.value.defaultAgentId;
  return allAgents.value.find((agent) => agent.name === pane.agentName)?.id
    ?? BUILTIN_AGENTS.find((agent) => agent.name === pane.agentName)?.id
    ?? schedulerSettings.value.defaultAgentId;
}

function buildAgentData(agentId: string, agentName: string, prompt: string, status: AgentData['status']): string {
  return JSON.stringify({
    providerId: agentId,
    providerName: agentName,
    prompt,
    status,
    startedAt: Date.now(),
  } satisfies AgentData);
}

async function createNodeForPane(
  paneId: string,
  spaceId: string,
  kind: 'shell' | 'agent',
  options: { agentId?: string; agentName?: string; prompt?: string } = {},
): Promise<void> {
  const payload: Record<string, unknown> = {
    id: paneId,
    space_id: spaceId,
    kind,
    title: kind === 'agent' ? (options.agentName ?? 'Agent') : 'Shell',
  };
  if (kind === 'agent' && options.agentId && options.agentName) {
    payload.agent_json = buildAgentData(options.agentId, options.agentName, options.prompt ?? '', 'idle');
  }
  await ipc.call('node.create', payload);
}

function requestSessionKill(sessionId?: string): void {
  if (!sessionId) return;
  void ipc.call('pty.kill', { session_id: sessionId }).catch((err) => {
    console.error('pty.kill failed:', err);
  });
}

async function spawnTerminal(
  kind: 'shell' | 'agent',
  agentName?: string,
  command?: string,
  prompt?: string,
  persistAgentEntity = true,
): Promise<PaneState | null> {
  let space = activeSpace.value;
  if (!space) {
    space = await createSpace('Default');
  }
  if (!space) return null;

  const paneId = nextPaneId();
  const agent = kind === 'agent' && agentName
    ? resolveAgentDefinition(allAgents.value.find((entry) => entry.name === agentName)?.id
      ?? BUILTIN_AGENTS.find((entry) => entry.name === agentName)?.id
      ?? schedulerSettings.value.defaultAgentId)
    : null;
  try {
    await createNodeForPane(paneId, space.id, kind, {
      agentId: agent?.id,
      agentName,
      prompt,
    });
  } catch (err) {
    console.warn('node.create failed:', err);
  }

  // Use workspace path as cwd, default to home/.claude for agents
  const cwd = workspacePath.value || undefined;
  const params: Record<string, unknown> = { kind, space_id: space.id, node_id: paneId };
  if (cwd) params.cwd = cwd;
  if (command) params.command = command;

  let result: { session_id: string };
  try {
    result = await ipc.call<{ session_id: string }>('pty.spawn', params);
  } catch (err) {
    void ipc.call('node.delete', { id: paneId }).catch(() => {});
    console.error('pty.spawn failed:', err);
    return null;
  }

  const pane: PaneState = {
    id: paneId,
    kind,
    spaceId: space.id,
    sessionId: result.session_id,
    agentName,
    prompt,
    sessionStatus: 'running',
    lastActivityAt: Date.now(),
  };

  panes.value = [...panes.value, pane];
  focusedPaneId.value = pane.id;
  scheduleIdleTransition(result.session_id);

  // Persist agent to backend for restoration on reload
  if (kind === 'agent' && agentName && persistAgentEntity) {
    const agentProvider = allAgents.value.find(a => a.name === agentName) ?? BUILTIN_AGENTS.find(a => a.name === agentName);
    ipc.call('agent.create', {
      id: paneId,
      space_id: space.id,
      provider_id: agentProvider?.id ?? 'claude',
      provider_name: agentName,
      status: 'running',
      session_id: result.session_id,
      prompt,
      node_id: paneId,
    }).then(() => ipc.call('agent.update', {
      id: paneId,
      status: 'running',
      session_id: result.session_id,
      prompt,
    })).catch(err => console.warn('agent.create failed:', err));
  }

  return pane;
}

async function createPendingAgentPaneForTask(taskId: string, agentId = schedulerSettings.value.defaultAgentId): Promise<PaneState | null> {
  const taskPane = panes.value.find((pane) => pane.id === taskId && pane.kind === 'task');
  const task = tasks.value.get(taskId);
  if (!taskPane || !task) return null;

  if (taskPane.linkedPaneId) {
    const existing = panes.value.find((pane) => pane.id === taskPane.linkedPaneId);
    if (existing) return existing;
  }

  const agent = resolveAgentDefinition(agentId);
  if (!agent) return null;

  const pendingPane: PaneState = {
    id: nextPaneId(),
    kind: 'agent',
    spaceId: taskPane.spaceId,
    agentName: agent.name,
    prompt: task.description || task.title,
    sessionStatus: 'pending',
    embedded: true,
  };

  try {
    await createNodeForPane(pendingPane.id, taskPane.spaceId, 'agent', {
      agentId: agent.id,
      agentName: agent.name,
      prompt: pendingPane.prompt,
    });
  } catch (err) {
    console.warn('node.create failed:', err);
  }

  panes.value = [...panes.value, pendingPane];
  linkPane(taskId, pendingPane.id);
  return pendingPane;
}

async function activatePendingAgentPane(paneId: string, agentId: string, prompt: string): Promise<PaneState | null> {
  const pane = panes.value.find((entry) => entry.id === paneId && entry.kind === 'agent');
  const agent = resolveAgentDefinition(agentId);
  if (!pane || !agent) return null;

  const cwd = workspacePath.value || undefined;
  const params: Record<string, unknown> = {
    kind: 'agent',
    space_id: pane.spaceId,
    node_id: pane.id,
  };
  if (cwd) params.cwd = cwd;
  if (agent.command) params.command = agent.command;

  let result: { session_id: string };
  try {
    result = await ipc.call<{ session_id: string }>('pty.spawn', params);
  } catch (err) {
    console.error('pty.spawn failed:', err);
    return null;
  }

  updatePane(pane.id, {
    agentName: agent.name,
    prompt,
    sessionId: result.session_id,
    sessionStatus: 'running',
    lastActivityAt: Date.now(),
  });
  scheduleIdleTransition(result.session_id);

  setTimeout(() => {
    ipc.call('pty.write', { session_id: result.session_id, data: prompt + '\r' }).catch(() => {});
  }, 2500);

  return panes.value.find((entry) => entry.id === pane.id) ?? null;
}

// -- Public actions --

export async function spawnAgent(agentId: string, prompt: string, persistAgentEntity = true): Promise<PaneState | null> {
  const agent = allAgents.value.find(a => a.id === agentId) ?? BUILTIN_AGENTS.find(a => a.id === agentId);
  if (!agent) return null;

  // Launch interactive TUI
  const pane = await spawnTerminal('agent', agent.name, agent.command, prompt, persistAgentEntity);

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
    setTimeout(async () => {
      // Send prompt content first
      await ipc.call('pty.write', { session_id: pane.sessionId, data: prompt }).catch(() => {});
      // Wait a bit for terminal to process the content, then send Enter
      setTimeout(() => {
        ipc.call('pty.write', { session_id: pane.sessionId, data: '\r' }).catch(() => {});
      }, 100);
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
  const agentPane = await spawnAgent(agentId, prompt, false);
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
      'medium'
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

    const task = applyTaskEntity(taskId, (currentTask) => ({
      ...currentTask,
      queueStatus: 'queued',
      queuedAt: Date.now(),
    }));
    await runSchedulerDispatch(task?.spaceId);
  } catch (err) {
    console.error('task.enqueue failed:', err);
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
  // Check if needsAttention is transitioning from false to true
  if (updates.needsAttention === true) {
    const currentPane = panes.value.find(p => p.id === paneId);
    if (currentPane && !currentPane.needsAttention) {
      // Trigger one-time shake animation
      triggerPaneShake(paneId);
    }
  }
  panes.value = panes.value.map(p => p.id === paneId ? { ...p, ...updates } : p);
  archivedPanes.value = archivedPanes.value.map(p => p.id === paneId ? { ...p, ...updates } : p);
}

export function linkPane(sourcePaneId: string, targetPaneId: string) {
  updatePane(sourcePaneId, { linkedPaneId: targetPaneId });
}

export function archivePane(paneId: string) {
  const pane = panes.value.find((entry) => entry.id === paneId);
  if (!pane) return;
  if (pane.kind === 'task' && pane.linkedPaneId) {
    archivePane(pane.linkedPaneId);
  }
  panes.value = panes.value.filter((entry) => entry.id !== paneId);
  archivedPanes.value = [
    { ...pane, archived: true, archivedAt: Date.now(), needsAttention: false },
    ...archivedPanes.value.filter((entry) => entry.id !== paneId),
  ];
  if (focusedPaneId.value === paneId) {
    focusedPaneId.value = panes.value[panes.value.length - 1]?.id ?? null;
  }
}

export function unarchivePane(paneId: string) {
  const pane = archivedPanes.value.find((entry) => entry.id === paneId);
  if (!pane) return;
  archivedPanes.value = archivedPanes.value.filter((entry) => entry.id !== paneId);
  panes.value = [...panes.value, { ...pane, archived: false, archivedAt: undefined }];
}

async function deletePaneInternal(paneId: string, origin: 'direct' | 'task-delete'): Promise<void> {
  const pane = panes.value.find(p => p.id === paneId);
  if (!pane) return;

  if (pane.kind === 'task' && pane.linkedPaneId) {
    await deletePaneInternal(pane.linkedPaneId, 'task-delete');
  }

  const linkedTaskPane = pane.kind !== 'task'
    ? panes.value.find(p => p.kind === 'task' && p.linkedPaneId === paneId)
    : undefined;
  const linkedTask = linkedTaskPane ? tasks.value.get(linkedTaskPane.id) : undefined;
  const stopManagedTaskFromBackend = origin === 'direct'
    && pane.kind === 'agent'
    && Boolean(linkedTask)
    && linkedTask.status !== 'done';

  if (pane.sessionId && pane.sessionStatus !== 'exited' && !stopManagedTaskFromBackend) {
    requestSessionKill(pane.sessionId);
  }

  if (linkedTaskPane && origin === 'direct') {
    if (pane.kind === 'agent' && linkedTask && linkedTask.status !== 'done') {
      await stopTaskExecution(linkedTask.id, false);
    } else if (pane.kind === 'shell') {
      updatePane(linkedTaskPane.id, { taskStatus: 'todo' });
    }
  }

  if (pane.kind === 'agent' && !isSlotAgentId(pane.id) && agents.value.has(pane.id)) {
    const newAgents = new Map(agents.value);
    newAgents.delete(pane.id);
    agents.value = newAgents;
    await ipc.call('agent.delete', { id: pane.id }).catch((err) => {
      console.error('agent.delete failed:', err);
    });
  }

  if (pane.kind === 'agent' || pane.kind === 'shell') {
    await ipc.call('node.delete', { id: pane.id }).catch((err) => {
      console.error('node.delete failed:', err);
    });
  }

  if (pane.kind === 'task' && tasks.value.has(paneId)) {
    const task = tasks.value.get(paneId);
    if (task?.assignedAgentId) {
      clearAgentAssignmentLocal(task.assignedAgentId, 'idle', true);
    }

    const newTasks = new Map(tasks.value);
    newTasks.delete(paneId);
    tasks.value = newTasks;

    await ipc.call('task.delete', { id: paneId }).catch((err) => {
      console.error('task.delete failed:', err);
    });
  }

  panes.value = panes.value
    .filter(p => p.id !== paneId)
    .map(p => p.linkedPaneId === paneId ? { ...p, linkedPaneId: undefined } : p);
  notes.value = notes.value.map(n => n.linkedPaneId === paneId ? { ...n, linkedPaneId: undefined } : n);

  if (focusedPaneId.value === paneId) {
    const remaining = panes.value;
    focusedPaneId.value = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
  }
}

export async function deletePane(paneId: string): Promise<void> {
  await deletePaneInternal(paneId, 'direct');
}

export async function markSessionExited(sessionId: string): Promise<void> {
  const idleTimer = sessionIdleTimers.get(sessionId);
  if (idleTimer) {
    window.clearTimeout(idleTimer);
    sessionIdleTimers.delete(sessionId);
  }
  panes.value = panes.value.map(p =>
    p.sessionId === sessionId ? { ...p, sessionStatus: 'exited' as const, needsAttention: false } : p
  );
  try {
    const result = await ipc.call<SchedulerSessionExitResult>('scheduler.handleSessionExit', { session_id: sessionId });
    if (result.kind === 'slot') {
      if (result.task_id) completeTaskLocal(result.task_id);
      if (result.agent_id) clearAgentAssignmentLocal(result.agent_id, result.agent_status ?? 'idle', true);
      if (result.space_id) {
        await pruneExcessIdleSlots(result.space_id);
        await runSchedulerDispatch(result.space_id);
      }
    } else if (result.kind === 'standalone' && result.agent_id) {
      clearAgentAssignmentLocal(result.agent_id, result.agent_status ?? 'exited', true);
    }
  } catch (err) {
    console.error('scheduler.handleSessionExit failed:', err);
  }
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

  if (oldLinked?.sessionId && oldLinked.sessionStatus === 'running') {
    requestSessionKill(oldLinked.sessionId);
  }

  if (oldLinked) {
    panes.value = panes.value.filter(p => p.id !== oldLinked.id);
    if (oldLinked.kind === 'agent' && !isSlotAgentId(oldLinked.id) && agents.value.has(oldLinked.id)) {
      const newAgents = new Map(agents.value);
      newAgents.delete(oldLinked.id);
      agents.value = newAgents;
      void ipc.call('agent.delete', { id: oldLinked.id }).catch((err) => {
        console.error('agent.delete failed:', err);
      });
    }
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

  if (sourcePane.sessionId && sourcePane.sessionStatus === 'running') {
    requestSessionKill(sourcePane.sessionId);
  }

  // Spawn new agent with context
  const newPane = await spawnAgent(targetAgentId, context);

  // Delete the original pane after new agent is spawned
  panes.value = panes.value.filter(p => p.id !== sourcePaneId);
  if (!isSlotAgentId(sourcePaneId) && agents.value.has(sourcePaneId)) {
    const newAgents = new Map(agents.value);
    newAgents.delete(sourcePaneId);
    agents.value = newAgents;
    void ipc.call('agent.delete', { id: sourcePaneId }).catch((err) => {
      console.error('agent.delete failed:', err);
    });
  }

  return newPane;
}

export function focusPane(paneId: string) {
  focusedPaneId.value = paneId;
  clearPaneAttention(paneId);
}

export async function createSpace(name: string, id?: string): Promise<SpaceState | null> {
  const workspaceId = currentWorkspaceId.value ?? await ensureWorkspace();
  if (!workspaceId) return null;

  const optimisticId = id ?? `space-${Date.now()}`;
  const optimisticSpace = { id: optimisticId, name };
  spaces.value = [...spaces.value, optimisticSpace];
  activeSpaceId.value = optimisticSpace.id;

  try {
    const created = await ipc.call<{ id: string }>('space.create', {
      workspace_id: workspaceId,
      name,
      id: optimisticId,
    });

    if (created.id !== optimisticId) {
      spaces.value = spaces.value.map(space =>
        space.id === optimisticId ? { ...space, id: created.id } : space
      );
      if (activeSpaceId.value === optimisticId) {
        activeSpaceId.value = created.id;
      }
      return { id: created.id, name };
    }

    return optimisticSpace;
  } catch (err) {
    console.error('space.create failed:', err);
    return optimisticSpace;
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
    workspaceUiStateReady = false;
    const state = await ipc.call<HydratedState>('state.hydrate', {});
    archivedPanes.value = [];

    // Restore spaces and panes from first workspace
    if (state.workspaces.length > 0) {
      const ws = state.workspaces[0];
      const restoredSpaces: SpaceState[] = [];
      const restoredPanes: PaneState[] = [];
      const restoredTasks = new Map<string, TaskEntity>();
      const restoredAgents = new Map<string, AgentEntity>();
      currentWorkspaceId.value = ws.id;

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

        // Re-spawn PTY sessions for shells and restore agent sessions
        for (const pane of restoredPanes) {
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
          // Restore agent sessions linked to tasks
          if (pane.kind === 'task' && pane.linkedPaneId) {
            const linkedPane = restoredPanes.find(p => p.id === pane.linkedPaneId);
            if (linkedPane?.kind === 'agent' && linkedPane.prompt) {
              try {
                const resp = await ipc.call<{ session_id: string }>('pty.spawn', {
                  cwd,
                  kind: 'agent',
                  agent_name: linkedPane.agentName ?? 'claude',
                  prompt: linkedPane.prompt,
                  space_id: linkedPane.spaceId,
                  node_id: linkedPane.id,
                });
                updatePane(linkedPane.id, {
                  sessionId: resp.session_id,
                  sessionStatus: 'running',
                });
              } catch (err) {
                console.warn('Failed to respawn agent for', linkedPane.id, err);
              }
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
  version: 1 | 2 | 3;
  exportedAt: number;
  workspace: {
    id: string;
    path: string;
    activeSpaceId?: string;
    focusedPaneId?: string;
  };
  spaces: Array<{
    id: string;
    name: string;
  }>;
  tasks: TaskEntity[];
  agents: AgentEntity[];
  panes?: PaneState[];
  archivedPanes?: PaneState[];
  notes: NoteState[];
  schedulerSettings: SchedulerSettings;
  layoutMode?: 'horizontal' | 'vertical';
}

// Export current workspace state to JSON (frontend snapshot)
export function exportWorkspaceToJson(): string {
  const wsId = currentWorkspaceId.value || 'unknown';
  const exported: ExportedWorkspace = {
    version: 3,
    exportedAt: Date.now(),
    workspace: {
      id: wsId,
      path: workspacePath.value,
      activeSpaceId: activeSpaceId.value ?? undefined,
      focusedPaneId: focusedPaneId.value ?? undefined,
    },
    spaces: spaces.value,
    tasks: Array.from(tasks.value.values()),
    agents: Array.from(agents.value.values()).filter((agent) => !isSlotAgentId(agent.id)),
    panes: panes.value,
    archivedPanes: archivedPanes.value,
    notes: notes.value,
    schedulerSettings: schedulerSettings.value,
    layoutMode: layoutMode.value,
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

function normalizeImportedAgentStatus(status: AgentEntity['status']): AgentEntity['status'] {
  return status === 'running' ? 'exited' : status;
}

async function clearCurrentWorkspaceState(): Promise<void> {
  for (const pane of panes.value) {
    if (pane.sessionId && pane.sessionStatus === 'running') {
      requestSessionKill(pane.sessionId);
    }
  }

  const existingSpaces = [...spaces.value];
  for (const space of existingSpaces) {
    await ipc.call('space.delete', { id: space.id });
  }

  spaces.value = [];
  panes.value = [];
  archivedPanes.value = [];
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

  if (data.version !== 1 && data.version !== 2 && data.version !== 3) {
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
  const restoredTasks = new Map<string, TaskEntity>();
  let pendingTasks = [...data.tasks];
  while (pendingTasks.length > 0) {
    const deferred: TaskEntity[] = [];
    let progressed = false;

    for (const task of pendingTasks) {
      const mappedSpaceId = spaceIdMap.get(task.spaceId) ?? activeSpaceId.value;
      if (!mappedSpaceId) {
        throw new Error(`Could not map imported task "${task.title}" to a space`);
      }

      const mappedParentTaskId = task.parentTaskId ? taskIdMap.get(task.parentTaskId) : undefined;
      if (task.parentTaskId && !mappedParentTaskId) {
        deferred.push(task);
        continue;
      }

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

      restoredTasks.set(createdId, {
        ...task,
        id: createdId,
        spaceId: mappedSpaceId,
        parentTaskId: mappedParentTaskId,
        status: normalized.status,
        queueStatus: normalized.queueStatus,
        assignedAgentId: undefined,
      });

      progressed = true;
    }

    if (!progressed) {
      throw new Error('Could not resolve imported task hierarchy because one or more parent task references are missing');
    }
    pendingTasks = deferred;
  }

  const agentIdMap = new Map<string, string>();
  const restoredAgents = new Map<string, AgentEntity>();
  for (const agent of data.agents) {
    if (isSlotAgentId(agent.id)) continue;

    const mappedSpaceId = spaceIdMap.get(agent.spaceId) ?? activeSpaceId.value;
    if (!mappedSpaceId) continue;

    const normalizedStatus = normalizeImportedAgentStatus(agent.status);
    await ipc.call('agent.create', {
      id: agent.id,
      space_id: mappedSpaceId,
      provider_id: agent.providerId,
      provider_name: agent.providerName,
      status: normalizedStatus,
      prompt: agent.prompt,
      node_id: agent.nodeId ?? agent.id,
    });

    agentIdMap.set(agent.id, agent.id);
    restoredAgents.set(agent.id, {
      ...agent,
      spaceId: mappedSpaceId,
      status: normalizedStatus,
      sessionId: undefined,
      assignedTaskId: undefined,
      startedAt: undefined,
    });
  }

  const paneIdMap = new Map<string, string>();
  const exportedPanes = Array.isArray(data.panes)
    ? data.panes
    : Array.from(restoredTasks.values()).map((task) => ({
      id: task.id,
      kind: 'task' as const,
      spaceId: task.spaceId,
      taskTitle: task.title,
      taskDescription: task.description,
      taskStatus: task.status,
      taskPriority: task.priority,
    }));

  const restoredPanes = exportedPanes.map((pane) => {
    let restoredId = pane.id;
    if (pane.kind === 'task') {
      restoredId = taskIdMap.get(pane.id) ?? pane.id;
    } else if (pane.kind === 'agent') {
      restoredId = agentIdMap.get(pane.id) ?? pane.id;
    }

    paneIdMap.set(pane.id, restoredId);

    return {
      ...pane,
      id: restoredId,
      spaceId: spaceIdMap.get(pane.spaceId) ?? activeSpaceId.value ?? pane.spaceId,
      sessionId: undefined,
      sessionStatus: pane.kind === 'task' ? undefined : 'exited' as const,
    };
  }).map((pane) => ({
    ...pane,
    linkedPaneId: pane.linkedPaneId ? paneIdMap.get(pane.linkedPaneId) : undefined,
  }));

  const restoredArchivedPanes = (data.archivedPanes ?? []).map((pane) => {
    let restoredId = pane.id;
    if (pane.kind === 'task') {
      restoredId = taskIdMap.get(pane.id) ?? pane.id;
    } else if (pane.kind === 'agent') {
      restoredId = agentIdMap.get(pane.id) ?? pane.id;
    }

    return {
      ...pane,
      id: restoredId,
      archived: true,
      spaceId: spaceIdMap.get(pane.spaceId) ?? activeSpaceId.value ?? pane.spaceId,
      linkedPaneId: pane.linkedPaneId ? paneIdMap.get(pane.linkedPaneId) : undefined,
      sessionId: undefined,
      sessionStatus: pane.kind === 'task' ? undefined : 'exited' as const,
    };
  });

  const restoredSpaces = data.spaces.map((space) => ({
    id: spaceIdMap.get(space.id) ?? space.id,
    name: space.name,
  }));

  const requestedActiveSpaceId = data.workspace.activeSpaceId
    ? spaceIdMap.get(data.workspace.activeSpaceId)
    : undefined;

  spaces.value = restoredSpaces;
  tasks.value = restoredTasks;
  agents.value = restoredAgents;
  panes.value = restoredPanes;
  archivedPanes.value = restoredArchivedPanes;
  activeSpaceId.value = requestedActiveSpaceId ?? restoredSpaces[0]?.id ?? null;
  focusedPaneId.value = data.workspace.focusedPaneId
    ? paneIdMap.get(data.workspace.focusedPaneId) ?? null
    : (restoredPanes[0]?.id ?? null);
  expandedPaneId.value = null;
  popoutPanes.value = new Map();
  if (data.layoutMode === 'horizontal' || data.layoutMode === 'vertical') {
    setLayoutMode(data.layoutMode);
  }

  notes.value = data.notes.map(note => ({
    ...note,
    spaceId: spaceIdMap.get(note.spaceId) ?? activeSpaceId.value ?? note.spaceId,
    linkedPaneId: note.linkedPaneId ? paneIdMap.get(note.linkedPaneId) : undefined,
  }));

  if (activeSpaceId.value) {
    await initializeAgentPool(importedSettings.concurrency);
  }
}

// Backend-backed export (full persistence)
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function exportWorkspace(workspaceId = currentWorkspaceId.value ?? undefined): Promise<{ filename: string; bytes: Uint8Array }> {
  void workspaceId;
  const exported = await ipc.call<{ filename: string; data: string }>('workspace.exportDb', {});
  return {
    filename: exported.filename,
    bytes: base64ToBytes(exported.data),
  };
}

export async function importWorkspace(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await ipc.call('workspace.importDb', {
    filename: file.name,
    data: bytesToBase64(bytes),
  });
  await hydrateState();
  await loadWorkspaceUiState();
  if (currentWorkspaceId.value) {
    await loadSchedulerSettings(currentWorkspaceId.value);
  }
  if (activeSpaceId.value) {
    await initializeAgentPool(schedulerSettings.value.concurrency);
  }
}

// -- Backend-authoritative scheduler flow --

async function startAssignedTask(taskId: string, slotId: string): Promise<void> {
  const slot = agentPool.value.get(slotId);
  if (!slot) return;

  const task = tasks.value.get(taskId);
  if (!task) return;

  const taskPane = panes.value.find((pane) => pane.id === taskId && pane.kind === 'task');
  const linkedPane = taskPane?.linkedPaneId
    ? panes.value.find((pane) => pane.id === taskPane.linkedPaneId && pane.kind === 'agent')
    : undefined;
  const agentProviderId = linkedPane
    ? resolveAgentIdFromPane(linkedPane)
    : (schedulerSettings.value.defaultAgentId?.trim() || slot.agentProviderId);
  const prompt = task.description || task.title;

  // 1. Spawn or activate the embedded agent pane for the assigned task
  const agentPane = linkedPane?.sessionStatus === 'pending'
    ? await activatePendingAgentPane(linkedPane.id, agentProviderId, prompt)
    : await spawnAgent(agentProviderId, prompt, false);

  if (!agentPane?.sessionId) {
    await stopTaskExecution(taskId);
    return;
  }

  // 2. Hand session ownership back to the backend scheduler
  let attachResult: SchedulerAttachTaskSessionResult;
  try {
    attachResult = await ipc.call<SchedulerAttachTaskSessionResult>('scheduler.attachTaskSession', {
      task_id: taskId,
      session_id: agentPane.sessionId,
    });
  } catch (err) {
    console.error('scheduler.attachTaskSession failed:', err);
    await deletePaneInternal(agentPane.id, 'task-delete');
    await stopTaskExecution(taskId);
    return;
  }

  const agent = agents.value.get(attachResult.agent_id);
  if (agent) {
    const updated = {
      ...agent,
      status: attachResult.agent_status ?? 'running',
      sessionId: attachResult.session_id,
    };
    agents.value = new Map(agents.value).set(attachResult.agent_id, updated);
  }

  // 3. Link the running pane to the task for UI
  updatePane(agentPane.id, { embedded: true });
  linkPane(taskId, agentPane.id);
  updatePane(taskId, { taskStatus: 'doing' });
}

effect(() => {
  const settings = schedulerSettings.value;
  const idle = idleSlots.value;
  const queued = queuedTasks.value;

  if (!settings.autoDispatch) return;

  const waitingTaskIds = queued.slice(idle.length).map((entry) => entry.taskId);
  for (const taskId of waitingTaskIds) {
    void createPendingAgentPaneForTask(taskId);
  }
});
