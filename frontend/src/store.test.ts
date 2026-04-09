import { describe, expect, it, vi } from 'vitest';
import * as store from './store';

describe('store startup and dispatch flows', () => {
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
      if (method === 'pty.spawn') return { session_id: 'session-42' };
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
    expect(ipcCall).toHaveBeenCalledWith('pty.spawn', { kind: 'agent', space_id: 'space-1', cwd: '/repo', command: 'claude' });
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
});
