import { useState } from 'preact/hooks';
import { executionHistory, clearExecutionHistory } from '../store';
import type { ExecutionRecord } from '../store';

interface Props {
  onClose: () => void;
}

export function ExecutionHistoryDialog({ onClose }: Props) {
  const history = executionHistory.value;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? history.find(r => r.id === selectedId) : null;

  const handleClear = () => {
    if (confirm('Clear all execution history?')) {
      clearExecutionHistory();
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatDuration = (start: number, end?: number) => {
    if (!end) return 'Running...';
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog history-dialog">
        <div class="dialog-header">
          Execution History
          <button class="history-clear" onClick={handleClear} title="Clear history">
            Clear
          </button>
        </div>

        <div class="history-content">
          <div class="history-list">
            {history.length === 0 ? (
              <div class="history-empty">No execution history yet</div>
            ) : (
              history.map(record => (
                <div
                  key={record.id}
                  class={`history-item ${record.id === selectedId ? 'selected' : ''} ${record.status}`}
                  onClick={() => setSelectedId(record.id)}
                >
                  <div class="history-item-header">
                    <span class={`history-status ${record.status}`}>
                      {record.status === 'running' ? '●' : record.status === 'completed' ? '✓' : '✗'}
                    </span>
                    <span class="history-agent">{record.agentName}</span>
                    <span class="history-time">{formatTime(record.startedAt)}</span>
                  </div>
                  <div class="history-prompt">{record.prompt.slice(0, 80)}{record.prompt.length > 80 ? '...' : ''}</div>
                  {record.taskTitle && (
                    <div class="history-task">Task: {record.taskTitle}</div>
                  )}
                </div>
              ))
            )}
          </div>

          {selected && (
            <div class="history-detail">
              <div class="history-detail-header">
                <span class="history-agent">{selected.agentName}</span>
                <span class={`history-status-badge ${selected.status}`}>{selected.status}</span>
              </div>
              <div class="history-detail-row">
                <span class="history-label">Started:</span>
                <span>{formatTime(selected.startedAt)}</span>
              </div>
              <div class="history-detail-row">
                <span class="history-label">Duration:</span>
                <span>{formatDuration(selected.startedAt, selected.endedAt)}</span>
              </div>
              {selected.taskTitle && (
                <div class="history-detail-row">
                  <span class="history-label">Task:</span>
                  <span>{selected.taskTitle}</span>
                </div>
              )}
              <div class="history-detail-section">
                <span class="history-label">Prompt:</span>
                <pre class="history-prompt-full">{selected.prompt}</pre>
              </div>
              {selected.outputPreview && (
                <div class="history-detail-section">
                  <span class="history-label">Output Preview:</span>
                  <pre class="history-output">{selected.outputPreview}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div class="dialog-actions">
          <button class="dialog-submit" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
