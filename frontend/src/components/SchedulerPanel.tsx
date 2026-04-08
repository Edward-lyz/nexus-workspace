import {
  schedulerSettings,
  pendingTasks,
  runningTasks,
  availableSlots,
} from '../store';

export function SchedulerPanel() {
  const settings = schedulerSettings.value;
  const pending = pendingTasks.value.length;
  const running = runningTasks.value.length;
  const slots = availableSlots.value;

  return (
    <div class="scheduler-panel">
      <div class="scheduler-header">
        <span class="scheduler-title">Scheduler</span>
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
          <span class="stat-value">{pending}</span>
          <span class="stat-label">Pending</span>
        </div>
        <div class="stat">
          <span class="stat-value">{running}</span>
          <span class="stat-label">Running</span>
        </div>
        <div class="stat">
          <span class="stat-value">{slots}</span>
          <span class="stat-label">Slots</span>
        </div>
      </div>
      <div class="scheduler-concurrency">
        <label>
          Max Concurrent:
          <input
            type="number"
            min="1"
            max="10"
            value={settings.concurrency}
            onChange={(e) => {
              const val = parseInt((e.target as HTMLInputElement).value) || 1;
              schedulerSettings.value = {
                ...settings,
                concurrency: Math.max(1, Math.min(10, val)),
              };
            }}
          />
        </label>
      </div>
    </div>
  );
}
