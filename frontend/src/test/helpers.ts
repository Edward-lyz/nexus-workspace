import * as store from '../store';

export function resetStoreState() {
  store.tasks.value = new Map();
  store.agents.value = new Map();
  store.schedulerSettingsEntity.value = null;
  store.schedulerSettings.value = {
    concurrency: 4,
    autoDispatch: true,
    defaultAgentId: 'claude',
  };
  store.executionHistory.value = [];
  store.customAgents.value = [];
  store.activeAgentId.value = 'claude';
  store.panes.value = [];
  store.focusedPaneId.value = null;
  store.expandedPaneId.value = null;
  store.popoutPanes.value = new Map();
  store.planModeAlert.value = null;
  store.notes.value = [];
  store.editingNoteId.value = null;
  store.spaces.value = [];
  store.activeSpaceId.value = null;
  store.currentWorkspaceId.value = null;
  store.workspacePath.value = '';
  localStorage.clear();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
}
