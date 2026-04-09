import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import * as store from '../store';

function renderSidebar() {
  const onAddTask = vi.fn();
  const onAddAgent = vi.fn();
  const onAddNote = vi.fn();

  render(<Sidebar onAddTask={onAddTask} onAddAgent={onAddAgent} onAddNote={onAddNote} />);

  return { onAddTask, onAddAgent, onAddNote };
}

describe('Sidebar', () => {
  it('wires primary action buttons for the active space', async () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';

    const { onAddTask, onAddAgent, onAddNote } = renderSidebar();

    await fireEvent.click(screen.getByText('+ Task'));
    await fireEvent.click(screen.getByText('+ Agent'));
    await fireEvent.click(screen.getByText('+ Note'));

    expect(onAddTask).toHaveBeenCalledWith({ id: 'space-1', name: 'Default' });
    expect(onAddAgent).toHaveBeenCalledWith({ id: 'space-1', name: 'Default' });
    expect(onAddNote).toHaveBeenCalledWith({ id: 'space-1', name: 'Default' });
  });

  it('toggles theme, creates a new space, and exports the workspace', async () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workspace');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'workspace.export') return { json: '{"workspace":true}' };
      throw new Error(`Unexpected method: ${method}`);
    });

    renderSidebar();

    await fireEvent.click(screen.getByTitle('Light Mode'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await fireEvent.click(screen.getByTitle('New Space'));
    const input = screen.getByPlaceholderText('Space name…');
    await fireEvent.input(input, { target: { value: 'QA' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.spaces.value.some((space) => space.name === 'QA')).toBe(true);

    await fireEvent.click(screen.getByTitle('Export Workspace'));

    await waitFor(() => {
      expect(ipcCall).toHaveBeenCalledWith('workspace.export', { workspace_id: 'ws-1' });
      expect(anchorClick).toHaveBeenCalledTimes(1);
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:workspace');
  });

  it('imports a workspace file through the hidden file input', async () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';

    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'workspace.import') return null;
      if (method === 'state.hydrate') {
        return {
          workspaces: [
            {
              id: 'ws-1',
              name: 'Workspace',
              path: '/repo',
              spaces: [
                { id: 'space-1', workspace_id: 'ws-1', name: 'Default', nodes: [], tasks: [], agents: [] },
              ],
            },
          ],
          settings: {},
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const { container } = render(<Sidebar onAddTask={vi.fn()} onAddAgent={vi.fn()} onAddNote={vi.fn()} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{"workspace":true}'], 'workspace.json', { type: 'application/json' });
    await fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(ipcCall).toHaveBeenCalledWith('workspace.import', { json: '{"workspace":true}' });
      expect(ipcCall).toHaveBeenCalledWith('state.hydrate', {});
    });
  });
});
