import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import * as store from '../store';

describe('StatusBar', () => {
  it('renders scheduler summary buttons and forwards click handlers', async () => {
    store.schedulerSettings.value = { concurrency: 2, autoDispatch: true, defaultAgentId: 'claude' };
    store.panes.value = [
      { id: 'task-1', kind: 'task', spaceId: 'space-1', taskStatus: 'todo' },
      { id: 'shell-1', kind: 'shell', spaceId: 'space-1', sessionId: 'shell-session', sessionStatus: 'running' },
      { id: 'agent-pane-1', kind: 'agent', spaceId: 'space-1', sessionId: 'agent-session', sessionStatus: 'running' },
      { id: 'agent-pane-2', kind: 'agent', spaceId: 'space-1', sessionStatus: 'exited' },
    ];
    store.agents.value = new Map([
      ['slot-1', {
        id: 'slot-1',
        spaceId: 'space-1',
        providerId: 'claude',
        providerName: 'Claude Code',
        status: 'running',
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);
    store.tasks.value = new Map([
      ['task-1', {
        id: 'task-1',
        spaceId: 'space-1',
        title: 'Queued task',
        description: 'Run me',
        status: 'todo',
        priority: 'medium',
        queueStatus: 'queued',
        queuedAt: 1,
        sortOrder: 0,
        createdAt: 1,
      }],
    ]);

    const onOpenSettings = vi.fn();
    const onOpenHistory = vi.fn();
    render(<StatusBar onOpenSettings={onOpenSettings} onOpenHistory={onOpenHistory} />);

    expect(screen.getByText('1 task · 2 sessions')).toBeTruthy();
    expect(screen.getByText('1 queued')).toBeTruthy();
    expect(screen.getByText('2 running')).toBeTruthy();
    expect(screen.getByText('auto on')).toBeTruthy();

    await fireEvent.click(screen.getByText('History'));
    await fireEvent.click(screen.getByText('Settings'));

    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
