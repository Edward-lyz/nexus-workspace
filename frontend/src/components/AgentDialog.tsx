import { BUILTIN_AGENTS, spawnAgentDirect } from '../store';
import type { SpaceState } from '../store';

interface Props {
  space: SpaceState | null;
  onClose: () => void;
}

export function AgentDialog({ space, onClose }: Props) {
  if (!space) return null;

  const launch = (agentId: string) => {
    spawnAgentDirect(agentId);
    onClose();
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog">
        <div class="dialog-header">Launch Agent</div>
        <label class="dialog-label">Select an agent to start</label>
        <div class="dialog-agent-grid">
          {BUILTIN_AGENTS.map(a => (
            <button
              key={a.id}
              class="agent-launch-btn"
              style={`--agent-color:${a.color}`}
              onClick={() => launch(a.id)}
            >
              <span class="agent-launch-name">{a.name}</span>
              <span class="agent-launch-cmd">{a.command}</span>
            </button>
          ))}
        </div>
        <div class="dialog-actions">
          <button class="dialog-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
