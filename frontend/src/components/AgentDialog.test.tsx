import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { AgentDialog } from './AgentDialog';
import * as store from '../store';

describe('AgentDialog', () => {
  it('launches the selected agent and closes the dialog', async () => {
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.workspacePath.value = '/repo';

    const onClose = vi.fn();
    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'node.create') return { id: params?.id ?? 'pane-1' };
      if (method === 'pty.spawn') return { session_id: 'session-7' };
      if (method === 'agent.create') return { id: params?.id ?? 'pane-1' };
      if (method === 'agent.update') return null;
      throw new Error(`Unexpected method: ${method}`);
    });

    render(<AgentDialog space={{ id: 'space-1', name: 'Default' }} onClose={onClose} />);

    await fireEvent.click(screen.getByText('Codex CLI'));

    await waitFor(() => {
      expect(ipcCall).toHaveBeenCalledWith('node.create', expect.objectContaining({
        id: expect.any(String),
        kind: 'agent',
        space_id: 'space-1',
      }));
      expect(ipcCall).toHaveBeenCalledWith('pty.spawn', {
        kind: 'agent',
        space_id: 'space-1',
        cwd: '/repo',
        command: 'codex',
        node_id: expect.any(String),
      });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.panes.value.find((pane) => pane.agentName === 'Codex CLI')).toMatchObject({
      kind: 'agent',
      sessionId: 'session-7',
    });
  });

  it('closes immediately when cancel is clicked', async () => {
    const onClose = vi.fn();

    render(<AgentDialog space={{ id: 'space-1', name: 'Default' }} onClose={onClose} />);

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
