import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { TaskDialog } from './TaskDialog';
import * as store from '../store';

describe('TaskDialog', () => {
  it('creates a single-line task prompt without background summarization', async () => {
    store.spaces.value = [{ id: 'space-1', name: 'Default' }];
    store.activeSpaceId.value = 'space-1';
    store.schedulerSettings.value = { concurrency: 4, autoDispatch: false, defaultAgentId: 'claude' };

    const onClose = vi.fn();
    const ipcCall = vi.spyOn(store.ipc, 'call').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'task.create') {
        return {
          id: 'task-1',
          space_id: 'space-1',
          title: params?.title,
          description: params?.description,
          status: 'todo',
          priority: params?.priority,
          queue_status: 'none',
          sort_order: 0,
          created_at: 1,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    render(<TaskDialog onClose={onClose} />);

    await fireEvent.input(screen.getByPlaceholderText('e.g., Fix login bug, Add dark mode...'), {
      target: { value: 'Cover startup dispatch' },
    });
    await fireEvent.click(screen.getByLabelText('High'));
    await fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(ipcCall).toHaveBeenCalledWith('task.create', {
        space_id: 'space-1',
        title: 'Cover startup dispatch',
        description: 'Cover startup dispatch',
        priority: 'high',
        parent_task_id: undefined,
      });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.tasks.value.get('task-1')).toMatchObject({
      title: 'Cover startup dispatch',
      description: 'Cover startup dispatch',
      priority: 'high',
    });
    expect(store.panes.value.find((pane) => pane.id === 'task-1')).toMatchObject({
      taskTitle: 'Cover startup dispatch',
      taskDescription: 'Cover startup dispatch',
      taskPriority: 'high',
    });
  });

  it('closes without creating a task when cancel is clicked', async () => {
    const onClose = vi.fn();
    const ipcCall = vi.spyOn(store.ipc, 'call');

    render(<TaskDialog onClose={onClose} />);

    await fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ipcCall).not.toHaveBeenCalled();
  });
});
