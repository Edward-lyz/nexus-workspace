import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionHistoryDialog } from './ExecutionHistoryDialog';
import * as store from '../store';

describe('ExecutionHistoryDialog', () => {
  it('clears history after confirmation and closes on demand', async () => {
    store.executionHistory.value = [
      {
        id: 'exec-1',
        agentId: 'claude',
        agentName: 'Claude Code',
        prompt: 'Run tests',
        startedAt: Date.now(),
        status: 'completed',
      },
    ];

    const onClose = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<ExecutionHistoryDialog onClose={onClose} />);

    await fireEvent.click(screen.getByText('Clear'));
    expect(store.executionHistory.value).toHaveLength(0);

    await fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
