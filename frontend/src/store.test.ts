import { afterEach, describe, expect, it, vi } from 'vitest';
import * as store from './store';

describe('store startup and dispatch flows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    store.spaces.value = [];
    store.activeSpaceId.value = null;
    store.currentWorkspaceId.value = null;
    store.workspacePath.value = '';
    store.panes.value = [];
    store.archivedPanes.value = [];
    store.notes.value = [];
    store.tasks.value = new Map();
    store.agents.value = new Map();
    store.customAgents.value = [];
    store.executionHistory.value = [];
    store.layoutMode.value = 'horizontal';
    store.schedulerSettings.value = {
      concurrency: 4,
      autoDispatch: true,
      defaultAgentId: 'claude',
    };
  });

  it('hydrates persisted state and only respawns shell panes on startup', async () => {
    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'state.hydrate') {
        return {
          workspaces: [
            {
              id: 'ws-1',
              name: 'Workspace',
              path: '/repo',
              spaces: [
                {
                  id: 'space-1',
                  workspace_id: 'ws-1',
                  name: 'Default',
                  tasks: [
                    {
                      id: 'task-1',
                      space_id: 'space-1',
                      title: 'Persisted task',
                      description: 'Verify hydration',
                      status: 'todo',
                      priority: 'medium',
                      queue_status: 'none',
                      created_at: 1,
                    },
                  ],
                  agents: [
                    {
                      id: 'slot-1',
                      space_id: 'space-1',
                      provider_id: 'claude',
                      provider_name: 'Claude Code',
                      status: 'idle',
                      created_at: 1,
                    },
                  ],
                  nodes: [
                    {
                      id: 'shell-1',
                      space_id: 'space-1',
                      kind: 'shell',
                      title: 'Shell',
                    },
                  ],
                },
              ],
            },
          ],
          settings: {},
        };
      }

      if (method === 'pty.spawn') {
        return { session_id: 'session-1' };
      }

      throw new Error(`Unexpected method: ${method}`);
    });

    await store.hydrateState();

    expect(store.currentWorkspaceId.value).toBe('ws-1');
    expect(store.workspacePath.value).toBe('/repo');
    expect(store.activeSpaceId.value).toBe('space-1');
    expect(store.tasks.value.get('task-1')?.title).toBe('Persisted task');
    expect(store.agents.value.get('slot-1')?.providerName).toBe('Claude Code');
    expect(store.panes.value.find((pane) => pane.id === 'shell-1')).toMatchObject({
      sessionId: 'session-1',
      sessionStatus: 'running',
    });
    expect(ipcCall).toHaveBeenCalledWith('pty.spawn', {
      cwd: '/repo',
      kind: 'shell',
      space_id: 'space-1',
      node_id: 'shell-1',
    });
    expect(ipcCall).toHaveBeenCalledTimes(2);
  });

  it('auto-dispatches queued tasks into idle slots during startup scheduling', async () => {
    vi.useFakeTimers();

    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.workspacePath.value = '/repo';
    store.schedulerSettings.value = {
      concurrency: 1,
      autoDispatch: true,
      defaultAgentId: 'claude',
    };
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Queued task',
        taskDescription: 'Dispatch me',
        taskStatus: 'todo',
        taskPriority: 'high',
      },
    ];
    store.agents.value = new Map([
      ['slot-1', {
        id: 'slot-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'idle',
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);

    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'task.assign') return null;
      if (method === 'node.create') return { id: params?.id ?? 'pane-1' };
      if (method === 'pty.spawn') return { session_id: 'session-42' };
      if (method === 'agent.create') return { id: params?.id ?? 'pane-1' };
      if (method === 'agent.update') return null;
      if (method === 'pty.write') return null;
      throw new Error(`Unexpected method: ${method} ${JSON.stringify(params)}`);
    });

    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Queued task',
        description: 'Dispatch me',
        status: 'todo',
        priority: 'high',
        queueStatus: 'queued',
        queuedAt: 10,
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(2500);

    expect(ipcCall).toHaveBeenCalledWith('task.assign', { task_id: 'task-1', agent_id: 'slot-1' });
    expect(ipcCall).toHaveBeenCalledWith('node.create', expect.objectContaining({
      id: expect.any(String),
      kind: 'agent',
      space_id: 'space-1',
    }));
    expect(ipcCall).toHaveBeenCalledWith('pty.spawn', {
      kind: 'agent',
      space_id: 'space-1',
      cwd: '/repo',
      command: 'claude',
      node_id: expect.any(String),
    });
    expect(ipcCall).toHaveBeenCalledWith('agent.update', { id: 'slot-1', session_id: 'session-42' });
    expect(ipcCall).toHaveBeenCalledWith('pty.write', { session_id: 'session-42', data: 'Dispatch me\r' });
    expect(store.tasks.value.get('task-1')).toMatchObject({
      assignedAgentId: 'slot-1',
      queueStatus: 'dispatched',
      status: 'doing',
    });
    expect(store.agents.value.get('slot-1')).toMatchObject({
      assignedTaskId: 'task-1',
      status: 'running',
      sessionId: 'session-42',
    });
    expect(store.panes.value.find((pane) => pane.kind === 'agent')).toMatchObject({
      embedded: true,
      sessionId: 'session-42',
    });
    expect(store.panes.value.find((pane) => pane.id === 'task-1')?.linkedPaneId).toBeTruthy();
  });

  it('reconciles stale running slot state during pool initialization', async () => {
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.schedulerSettings.value = {
      concurrency: 1,
      autoDispatch: true,
      defaultAgentId: 'claude',
    };
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Queued task',
        taskDescription: 'Dispatch me',
        taskStatus: 'doing',
        taskPriority: 'high',
      },
    ];
    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Queued task',
        description: 'Dispatch me',
        status: 'doing',
        priority: 'high',
        queueStatus: 'dispatched',
        assignedAgentId: 'slot-1',
        dispatchedAt: 10,
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);

    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'agent.list') {
        return [
          {
            id: 'slot-1',
            space_id: 'space-1',
            provider_id: 'claude',
            provider_name: 'Claude Code',
            status: 'running',
            session_id: 'session-stale',
            assigned_task_id: 'task-1',
            sort_order: 0,
            created_at: 1,
          },
        ];
      }
      if (method === 'task.resetDispatch') return null;
      throw new Error(`Unexpected method: ${method}`);
    });

    await store.initializeAgentPool(1);

    expect(ipcCall).toHaveBeenCalledWith('task.resetDispatch', { id: 'task-1', requeue: true });
    expect(store.tasks.value.get('task-1')).toMatchObject({
      status: 'todo',
      queueStatus: 'queued',
      assignedAgentId: undefined,
    });
    expect(store.agents.value.get('slot-1')).toMatchObject({
      status: 'idle',
      assignedTaskId: undefined,
      sessionId: undefined,
    });
  });

  it('marks dispatched tasks done and frees the slot when the session exits', async () => {
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Queued task',
        taskDescription: 'Dispatch me',
        taskStatus: 'doing',
        taskPriority: 'high',
      },
      {
        id: 'pane-2',
        kind: 'agent',
        spaceId: 'space-1',
        sessionId: 'session-42',
        sessionStatus: 'running',
        embedded: true,
      },
    ];
    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Queued task',
        description: 'Dispatch me',
        status: 'doing',
        priority: 'high',
        queueStatus: 'dispatched',
        assignedAgentId: 'slot-1',
        dispatchedAt: 10,
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);
    store.agents.value = new Map([
      ['slot-1', {
        id: 'slot-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        sessionId: 'session-42',
        assignedTaskId: 'task-1',
        startedAt: 10,
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);

    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'task.unassign') return null;
      throw new Error(`Unexpected method: ${method}`);
    });

    await store.markSessionExited('session-42');

    expect(ipcCall).toHaveBeenCalledWith('task.unassign', { id: 'task-1' });
    expect(store.tasks.value.get('task-1')).toMatchObject({
      status: 'done',
      queueStatus: 'completed',
      assignedAgentId: undefined,
    });
    expect(store.agents.value.get('slot-1')).toMatchObject({
      status: 'idle',
      assignedTaskId: undefined,
      sessionId: undefined,
    });
    expect(store.panes.value.find((pane) => pane.id === 'task-1')).toMatchObject({
      taskStatus: 'done',
    });
  });

  it('deletes linked agent sessions and clears running slot state with the task', async () => {
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        linkedPaneId: 'pane-2',
        taskTitle: 'Queued task',
        taskDescription: 'Dispatch me',
        taskStatus: 'doing',
        taskPriority: 'high',
      },
      {
        id: 'pane-2',
        kind: 'agent',
        spaceId: 'space-1',
        sessionId: 'session-42',
        sessionStatus: 'running',
        embedded: true,
      },
    ];
    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Queued task',
        description: 'Dispatch me',
        status: 'doing',
        priority: 'high',
        queueStatus: 'dispatched',
        assignedAgentId: 'slot-1',
        dispatchedAt: 10,
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);
    store.agents.value = new Map([
      ['slot-1', {
        id: 'slot-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        sessionId: 'session-42',
        assignedTaskId: 'task-1',
        startedAt: 10,
        sortOrder: 0,
        createdAt: 1,
      }],
      ['pane-2', {
        id: 'pane-2',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        sessionId: 'session-42',
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);

    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'pty.kill') return null;
      if (method === 'agent.delete') return null;
      if (method === 'task.delete') return null;
      throw new Error(`Unexpected method: ${method} ${JSON.stringify(params)}`);
    });

    await store.deletePane('task-1');

    expect(ipcCall).toHaveBeenCalledWith('pty.kill', { session_id: 'session-42' });
    expect(ipcCall).toHaveBeenCalledWith('agent.delete', { id: 'pane-2' });
    expect(ipcCall).toHaveBeenCalledWith('task.delete', { id: 'task-1' });
    expect(store.panes.value).toHaveLength(0);
    expect(store.tasks.value.has('task-1')).toBe(false);
    expect(store.agents.value.get('slot-1')).toMatchObject({
      status: 'idle',
      assignedTaskId: undefined,
      sessionId: undefined,
    });
    expect(store.agents.value.has('pane-2')).toBe(false);
  });

  it('prunes idle slots beyond the configured concurrency during pool initialization', async () => {
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.schedulerSettings.value = {
      concurrency: 1,
      autoDispatch: true,
      defaultAgentId: 'claude',
    };

    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'agent.list') {
        return [
          {
            id: 'slot-1',
            space_id: 'space-1',
            provider_id: 'claude',
            provider_name: 'Claude Code',
            status: 'idle',
            sort_order: 0,
            created_at: 1,
          },
          {
            id: 'slot-2',
            space_id: 'space-1',
            provider_id: 'claude',
            provider_name: 'Claude Code',
            status: 'idle',
            sort_order: 1,
            created_at: 2,
          },
        ];
      }
      if (method === 'agent.delete') return null;
      throw new Error(`Unexpected method: ${method}`);
    });

    await store.initializeAgentPool(1);

    expect(ipcCall).toHaveBeenCalledWith('agent.delete', { id: 'slot-2' });
    expect(store.agentPool.value.size).toBe(1);
    expect(store.agents.value.has('slot-2')).toBe(false);
  });

  it('creates pending agent panes for queued work beyond available concurrency', async () => {
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.schedulerSettings.value = {
      concurrency: 1,
      autoDispatch: true,
      defaultAgentId: 'claude',
    };
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Running task',
        taskDescription: 'Already dispatched',
        taskStatus: 'doing',
        taskPriority: 'high',
      },
      {
        id: 'task-2',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Queued task',
        taskDescription: 'Wait for a slot',
        taskStatus: 'todo',
        taskPriority: 'medium',
      },
    ];
    store.agents.value = new Map([
      ['slot-1', {
        id: 'slot-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        assignedTaskId: 'task-1',
        sessionId: 'session-live',
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);
    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Running task',
        description: 'Already dispatched',
        status: 'doing',
        priority: 'high',
        queueStatus: 'dispatched',
        assignedAgentId: 'slot-1',
        sortOrder: 0,
        createdAt: 1,
      }],
      ['task-2', {
        id: 'task-2',
        spaceId: 'space-1',
        title: 'Queued task',
        description: 'Wait for a slot',
        status: 'todo',
        priority: 'medium',
        queueStatus: 'queued',
        queuedAt: 20,
        sortOrder: 1,
        createdAt: 2,
      }],
    ]);

    await Promise.resolve();
    await Promise.resolve();

    const taskPane = store.panes.value.find((pane) => pane.id === 'task-2');
    const linkedPane = taskPane?.linkedPaneId
      ? store.panes.value.find((pane) => pane.id === taskPane.linkedPaneId)
      : undefined;

    expect(linkedPane).toMatchObject({
      kind: 'agent',
      embedded: true,
      sessionStatus: 'pending',
      prompt: 'Wait for a slot',
    });
  });

  it('exports workspace snapshots with panes and active workspace metadata', () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.workspacePath.value = '/repo';
    store.activeSpaceId.value = 'space-1';
    store.focusedPaneId.value = 'task-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Task',
        taskDescription: 'Describe it',
        taskStatus: 'doing',
        linkedPaneId: 'agent-1',
      },
      {
        id: 'agent-1',
        kind: 'agent',
        spaceId: 'space-1',
        agentName: 'Claude Code',
        prompt: 'Solve it',
        sessionId: 'session-1',
        sessionStatus: 'running',
        embedded: true,
      },
    ];
    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Task',
        description: 'Describe it',
        status: 'doing',
        priority: 'medium',
        queueStatus: 'dispatched',
        assignedAgentId: 'slot-1',
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);
    store.agents.value = new Map([
      ['slot-1', {
        id: 'slot-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        sessionId: 'session-slot',
        assignedTaskId: 'task-1',
        sortOrder: 0,
        createdAt: 1,
      }],
      ['agent-1', {
        id: 'agent-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        sessionId: 'session-1',
        prompt: 'Solve it',
        sortOrder: 1,
        createdAt: 2,
      }],
    ]);

    const exported = JSON.parse(store.exportWorkspaceToJson());

    expect(exported.version).toBe(3);
    expect(exported.workspace).toMatchObject({
      id: 'ws-1',
      path: '/repo',
      activeSpaceId: 'space-1',
      focusedPaneId: 'task-1',
    });
    expect(exported.panes).toHaveLength(2);
    expect(exported.agents).toHaveLength(1);
    expect(exported.agents[0].id).toBe('agent-1');
  });

  it('loads workspace-backed UI state from settings', async () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.panes.value = [
      {
        id: 'task-1',
        kind: 'task',
        spaceId: 'space-1',
        taskTitle: 'Task',
      },
      {
        id: 'agent-1',
        kind: 'agent',
        spaceId: 'space-1',
        agentName: 'Claude Code',
        sessionStatus: 'exited',
      },
    ];

    vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'settings.get') {
        throw new Error(`Unexpected method: ${method}`);
      }

      switch (params?.key) {
        case 'frontend.customAgents':
          return [{ id: 'claude-work', name: 'Claude Work', command: 'claude --profile work', color: '#60a5fa', isCustom: true }];
        case 'frontend.executionHistory':
          return [{ id: 'exec-1', agentId: 'claude', agentName: 'Claude Code', prompt: 'hello', startedAt: 1, status: 'completed' }];
        case 'frontend.layoutMode':
          return 'vertical';
        case 'frontend.notes':
          return [{ id: 'note-1', spaceId: 'space-1', text: 'remember this', createdAt: 1 }];
        case 'frontend.archivedPanes':
          return [{ id: 'agent-1', kind: 'agent', spaceId: 'space-1', agentName: 'Claude Code', archived: true, archivedAt: 2 }];
        case 'frontend.activeSpaceId':
          return 'space-1';
        case 'frontend.focusedPaneId':
          return 'task-1';
        default:
          return null;
      }
    });

    await store.loadWorkspaceUiState();

    expect(store.customAgents.value[0]?.id).toBe('claude-work');
    expect(store.executionHistory.value[0]?.id).toBe('exec-1');
    expect(store.layoutMode.value).toBe('vertical');
    expect(store.notes.value[0]?.id).toBe('note-1');
    expect(store.archivedPanes.value[0]).toMatchObject({ id: 'agent-1', archived: true });
    expect(store.panes.value.some((pane) => pane.id === 'agent-1')).toBe(false);
    expect(store.focusedPaneId.value).toBe('task-1');
  });
});
