import * as store from '../store';

function resetLocalStorage() {
  const storage = globalThis.localStorage as Partial<Storage> | undefined;
  if (!storage) return;

  if (typeof storage.clear === 'function') {
    storage.clear();
    return;
  }

  const removableKeys = new Set([
    'nexus-execution-history',
    'nexus-custom-agents',
    'nexus-layout-mode',
    'nexus-popout-positions',
  ]);

  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) removableKeys.add(key);
    }
  }

  if (typeof storage.removeItem === 'function') {
    for (const key of removableKeys) {
      storage.removeItem(key);
    }
  }
}

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
  store.archivedPanes.value = [];
  store.focusedPaneId.value = null;
  store.expandedPaneId.value = null;
  store.popoutPanes.value = new Map();
  store.layoutMode.value = 'horizontal';
  store.planModeAlert.value = null;
  store.notes.value = [];
  store.editingNoteId.value = null;
  store.spaces.value = [];
  store.activeSpaceId.value = null;
  store.currentWorkspaceId.value = null;
  store.workspacePath.value = '';
  resetLocalStorage();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
}
