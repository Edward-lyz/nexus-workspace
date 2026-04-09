import { useState, useRef, useEffect } from 'preact/hooks';
import {
  schedulerSettings,
  resizeAgentPool,
  BUILTIN_AGENTS,
  allAgents,
  customAgents,
  addCustomAgent,
  removeCustomAgent,
  ipc,
  currentWorkspaceId,
  exportWorkspace,
  importWorkspace,
} from '../store';

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const settings = schedulerSettings.value;
  const [concurrency, setConcurrency] = useState(settings.concurrency);
  const [autoDispatch, setAutoDispatch] = useState(settings.autoDispatch);
  const [defaultAgentId, setDefaultAgentId] = useState(settings.defaultAgentId);
  const [importError, setImportError] = useState<string | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentCommand, setNewAgentCommand] = useState('');
  const [newAgentColor, setNewAgentColor] = useState('#60a5fa');
  const initialRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { initialRef.current?.focus(); }, []);

  const handleSave = async () => {
    // Update local state
    schedulerSettings.value = {
      concurrency,
      autoDispatch,
      defaultAgentId,
    };

    // Persist to backend
    const wsId = currentWorkspaceId.value;
    if (wsId) {
      try {
        await ipc.call('scheduler.setSettings', {
          workspace_id: wsId,
          concurrency,
          auto_dispatch: autoDispatch,
          default_agent_id: defaultAgentId,
        });
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
    }

    // Resize pool if concurrency changed
    if (concurrency !== settings.concurrency) {
      await resizeAgentPool(concurrency);
    }

    onClose();
  };

  const handleExport = async () => {
    const wsId = currentWorkspaceId.value;
    if (!wsId) { alert('No workspace loaded'); return; }
    try {
      const json = await exportWorkspace();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexus-workspace-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      await importWorkspace(text);
      setImportError(null);
      onClose();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import');
    }

    // Reset input
    input.value = '';
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog dialog-wide">
        <div class="dialog-header">Settings</div>

        <div class="settings-section">
          <div class="settings-section-title">Agent Pool</div>

          <label class="settings-row">
            <span class="settings-label">Max Concurrent Agents</span>
            <input
              ref={initialRef}
              type="number"
              class="settings-input-number"
              min="1"
              max="10"
              value={concurrency}
              onChange={(e) => setConcurrency(Math.max(1, Math.min(10, parseInt((e.target as HTMLInputElement).value) || 1)))}
            />
          </label>

          <label class="settings-row">
            <span class="settings-label">Auto-Dispatch Tasks</span>
            <input
              type="checkbox"
              class="settings-checkbox"
              checked={autoDispatch}
              onChange={(e) => setAutoDispatch((e.target as HTMLInputElement).checked)}
            />
          </label>

          <label class="settings-row">
            <span class="settings-label">Default Agent</span>
            <select
              class="settings-select"
              value={defaultAgentId}
              onChange={(e) => setDefaultAgentId((e.target as HTMLSelectElement).value)}
            >
              {allAgents.value.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Custom Agents (CC Instances)</div>
          <div class="cc-agent-list">
            {customAgents.value.map(agent => (
              <div key={agent.id} class="cc-agent-item">
                <span class="cc-agent-color" style={{ background: agent.color }} />
                <span class="cc-agent-name">{agent.name}</span>
                <span class="cc-agent-cmd">{agent.command}</span>
                <button
                  class="cc-agent-delete"
                  onClick={() => removeCustomAgent(agent.id)}
                  title="Remove"
                >
                  x
                </button>
              </div>
            ))}
            {customAgents.value.length === 0 && !showAddAgent && (
              <div class="cc-agent-empty">No custom agents configured</div>
            )}
          </div>

          {showAddAgent ? (
            <div class="cc-agent-form">
              <input
                class="dialog-input"
                placeholder="Agent name (e.g., Claude Work)"
                value={newAgentName}
                onInput={(e) => setNewAgentName((e.target as HTMLInputElement).value)}
              />
              <input
                class="dialog-input"
                placeholder="Command (e.g., claude --profile work)"
                value={newAgentCommand}
                onInput={(e) => setNewAgentCommand((e.target as HTMLInputElement).value)}
              />
              <div class="cc-agent-form-row">
                <input
                  type="color"
                  class="cc-agent-color-picker"
                  value={newAgentColor}
                  onChange={(e) => setNewAgentColor((e.target as HTMLInputElement).value)}
                />
                <button
                  class="dialog-cancel"
                  onClick={() => {
                    setShowAddAgent(false);
                    setNewAgentName('');
                    setNewAgentCommand('');
                  }}
                >
                  Cancel
                </button>
                <button
                  class="dialog-submit"
                  onClick={() => {
                    if (newAgentName.trim() && newAgentCommand.trim()) {
                      addCustomAgent({
                        id: `custom-${Date.now()}`,
                        name: newAgentName.trim(),
                        command: newAgentCommand.trim(),
                        color: newAgentColor,
                      });
                      setShowAddAgent(false);
                      setNewAgentName('');
                      setNewAgentCommand('');
                    }
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          ) : (
            <button class="cc-agent-add" onClick={() => setShowAddAgent(true)}>
              + Add Custom Agent
            </button>
          )}
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Keyboard Shortcuts</div>
          <div class="settings-shortcuts">
            <div class="shortcut-row">
              <span class="shortcut-label">New Task</span>
              <kbd class="shortcut-key">Cmd+T</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-label">New Agent</span>
              <kbd class="shortcut-key">Cmd+K</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-label">New Note</span>
              <kbd class="shortcut-key">Cmd+J</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-label">Close Pane</span>
              <kbd class="shortcut-key">Cmd+W</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-label">Settings</span>
              <kbd class="shortcut-key">Cmd+,</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-label">History</span>
              <kbd class="shortcut-key">Cmd+H</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-label">Popout Pane</span>
              <kbd class="shortcut-key">Cmd+E</kbd>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Data Management</div>
          <div class="settings-data-actions">
            <button class="settings-data-btn export" onClick={handleExport}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Export Workspace
            </button>
            <button class="settings-data-btn import" onClick={handleImportClick}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Import Workspace
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
          </div>
          {importError && <div class="settings-error">{importError}</div>}
        </div>

        <div class="dialog-actions">
          <button class="dialog-cancel" onClick={onClose}>Cancel</button>
          <button class="dialog-submit" onClick={handleSave}>Save</button>
        </div>
        <div class="dialog-hint">Cmd+Enter to save</div>
      </div>
    </div>
  );
}
