import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import * as store from '../store';

function renderSidebar() {
  const onAddTask = vi.fn();
  const onAddAgent = vi.fn();
  const onAddNote = vi.fn();
  const onOpenSettings = vi.fn();
  const onOpenHistory = vi.fn();

  render(<Sidebar
    onAddTask={onAddTask}
    onAddAgent={onAddAgent}
    onAddNote={onAddNote}
    onOpenSettings={onOpenSettings}
    onOpenHistory={onOpenHistory}
  />);

  return { onAddTask, onAddAgent, onAddNote, onOpenSettings, onOpenHistory };
}

describe('Sidebar', () => {
  it('wires primary action buttons for the active space', async () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';

    const { onAddTask, onAddAgent, onAddNote } = renderSidebar();

    // Space is auto-expanded; buttons appear inside space-children
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
    const exportWorkspace = vi.spyOn(store, 'exportWorkspace').mockResolvedValue({
      filename: 'workspace.nexus.db',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string) => {
      if (method === 'space.create') return { id: 'space-test' };
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
      expect(exportWorkspace).toHaveBeenCalledTimes(1);
      expect(anchorClick).toHaveBeenCalledTimes(1);
    });
    expect(ipcCall).toHaveBeenCalledWith('space.create', expect.objectContaining({ workspace_id: 'ws-1', name: 'QA' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:workspace');
  });

  it('imports a workspace file through the hidden file input', async () => {
    store.currentWorkspaceId.value = 'ws-1';
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';

    const importWorkspace = vi.spyOn(store, 'importWorkspace').mockResolvedValue();

    const { container } = render(<Sidebar
      onAddTask={vi.fn()}
      onAddAgent={vi.fn()}
      onAddNote={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenHistory={vi.fn()}
    />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['sqlite'], 'workspace.nexus.db', { type: 'application/x-sqlite3' });
    await fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(importWorkspace).toHaveBeenCalledWith(file);
    });
  });
});
