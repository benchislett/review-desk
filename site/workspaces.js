const workspaceStates = {};
function defaultState(key) {
  return {
    workspace: key,
    view: bundle.workspaces[key].defaultView,
    q: '',
    author: '',
    label: '',
    involvement: 'all',
    drafts: 'all',
    followup: 'replies',
    sort: 'signal',
  };
}
function syncControls() {
  for (const key of ['author', 'label', 'involvement', 'drafts', 'sort']) $(key).value = state[key];
  $('search').value = state.q;
  $('hide-commit-updates').checked = state.followup === 'replies';
}
function activateWorkspace(key) {
  workspaceKey = Object.hasOwn(bundle.workspaces, key) ? key : bundle.defaultWorkspace;
  data = bundle.workspaces[workspaceKey];
  prs = data.pullRequests;
  counts = Object.fromEntries(
    queues.map((q) => [q[0], prs.filter((p) => p.queue === q[0]).length]),
  );
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  renderWorkspaceChrome();
}
function switchWorkspace(key) {
  if (!Object.hasOwn(bundle.workspaces, key)) return;
  workspaceStates[workspaceKey] = { ...state };
  activateWorkspace(key);
  state = { ...(workspaceStates[key] || defaultState(key)) };
  syncControls();
  saveHash();
  render();
}
$('workspace-select').innerHTML = Object.entries(bundle.workspaces)
  .map(([key, w]) => `<option value="${esc(key)}">${esc(w.repo)}</option>`)
  .join('');
$('workspace-select').addEventListener('change', () =>
  switchWorkspace($('workspace-select').value),
);
