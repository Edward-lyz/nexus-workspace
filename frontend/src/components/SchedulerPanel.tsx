import {
  schedulerSettings,
  agentPool,
  idleSlots,
  runningSlotsCount,
  queuedTasks,
  BUILTIN_AGENTS,
  resizeAgentPool,
  getTaskForAgent,
} from '../store';

export function SchedulerPanel() {
  const settings = schedulerSettings.value;
  const queued = queuedTasks.value.length;
  const running = runningSlotsCount.value;
  const idle = idleSlots.value.length;
  const pool = Array.from(agentPool.value.values());

  return (
    <div class="scheduler-panel">
      <div class="scheduler-header">
        <span class="scheduler-title">Agent Pool</span>
        <label class="scheduler-toggle">
          <input
            type="checkbox"
            checked={settings.autoDispatch}
            onChange={(e) => {
              schedulerSettings.value = {
                ...settings,
                autoDispatch: (e.target as HTMLInputElement).checked,
              };
            }}
          />
          <span>Auto</span>
        </label>
      </div>

      <div class="scheduler-stats">
        <div class="stat">
          <span class="stat-value">{queued}</span>
          <span class="stat-label">Queued</span>
        </div>
        <div class="stat">
          <span class="stat-value">{running}</span>
          <span class="stat-label">Running</span>
        </div>
        <div class="stat">
          <span class="stat-value">{idle}</span>
          <span class="stat-label">Idle</span>
        </div>
      </div>

      <div class="scheduler-concurrency">
        <label>
          Max Agents:
          <input
            type="number"
            min="1"
            max="10"
            value={settings.concurrency}
            onChange={(e) => {
              const val = parseInt((e.target as HTMLInputElement).value) || 1;
              const newConcurrency = Math.max(1, Math.min(10, val));
              schedulerSettings.value = {
                ...settings,
                concurrency: newConcurrency,
              };
              resizeAgentPool(newConcurrency);
            }}
          />
        </label>
      </div>

      <div class="scheduler-agent-select">
        <label>
          Default:
          <select
            value={settings.defaultAgentId}
            onChange={(e) => {
              schedulerSettings.value = {
                ...settings,
                defaultAgentId: (e.target as HTMLSelectElement).value,
              };
            }}
          >
            {BUILTIN_AGENTS.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Agent Pool Slots Visualization */}
      <div class="agent-pool-view">
        {pool.map(slot => {
          const assignedTask = getTaskForAgent(slot.slotId);
          return (
            <div key={slot.slotId} class={`agent-slot ${slot.status}`} title={assignedTask?.title}>
              <span class="slot-id">{slot.slotId.replace('slot-', '#')}</span>
              <span class={`slot-status ${slot.status}`}>{slot.status}</span>
              {assignedTask && <span class="slot-task">{assignedTask.title.slice(0, 20)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
