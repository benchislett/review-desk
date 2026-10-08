let liveStatus = null;
let liveRevision = `${bundle.instance || ''}:${bundle.revision || 0}`;
let currentPreview = null;
let statusPending = false;
let openRefreshTimer = null;
let returnTimer = null;
let toastTimer = null;
let lastJobNotice = null;
const returnTargets = new Map();
const recentReturns = new Map();
const dismissalPending = new Set();
const prKey = (workspace, number) => `${workspace}:${number}`;

function liveToast(message) {
  $('live-toast').textContent = message;
  $('live-toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('live-toast').hidden = true), 6000);
}
async function localAPI(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Review-Desk': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) {
    if (result.frozen && liveStatus) {
      liveStatus.frozen = true;
      updateLiveUI();
    }
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result;
}
function runningFor(workspace, number) {
  return (
    liveStatus &&
    [liveStatus.active, ...liveStatus.queued].some(
      (j) => j && j.workspace === workspace && j.number === number,
    )
  );
}
function renderDismissalControl(p) {
  return `<button class="text-button dismiss-button" data-dismiss-pr="${p.number}" data-dismissed="${!p.dismissal}" data-activity-version="${esc(p.activityVersion)}" title="${p.dismissal ? 'Restore automatic priority' : 'Move to Following until new activity arrives'}">${p.dismissal ? 'Undo dismissal' : 'Dismiss current activity'}</button>`;
}
async function changeDismissal(button) {
  const workspace = workspaceKey,
    number = Number(button.dataset.dismissPr),
    key = prKey(workspace, number);
  if (dismissalPending.has(key)) return;
  dismissalPending.add(key);
  updateLiveUI();
  try {
    const next = await localAPI('/api/dismissal', {
      workspace,
      number,
      dismissed: button.dataset.dismissed === 'true',
      activityVersion: button.dataset.activityVersion,
    });
    applyLiveData(next);
    if (
      currentPreview?.workspace === workspace &&
      currentPreview?.number === number &&
      $('detail').open
    ) {
      $('detail-content').querySelector('[data-dismiss-pr]')?.focus({ preventScroll: true });
    }
  } catch (error) {
    liveToast(error.message);
    await pollLiveStatus();
  } finally {
    dismissalPending.delete(key);
    updateLiveUI();
  }
}
function updateLiveUI() {
  if (!bundle.live) return;
  $('live-controls').hidden = false;
  $('offline-mode').hidden = true;
  updatePinControls();
  for (const button of document.querySelectorAll('[data-dismiss-pr]'))
    button.disabled = dismissalPending.has(prKey(workspaceKey, Number(button.dataset.dismissPr)));
  const frozen = liveStatus?.frozen;
  const rate = liveStatus?.rate;
  const stale = rate?.resetAt && new Date(rate.resetAt) <= new Date();
  const remaining = rate?.remaining;
  const limit = rate?.limit;
  for (const usage of [$('api-usage'), $('detail-api-usage')]) {
    usage.hidden = false;
    usage.textContent = frozen
      ? 'API frozen · resume'
      : rate && !stale
        ? `API ${remaining.toLocaleString()} left`
        : 'API · usage pending';
    usage.classList.toggle('frozen', !!frozen);
    usage.classList.toggle('low', !frozen && !!rate && !stale && remaining / limit <= 0.1);
    usage.setAttribute('aria-pressed', String(!!frozen));
    usage.title =
      (frozen
        ? 'All refreshes paused. Click to resume.'
        : `GitHub GraphQL points remaining${rate ? ' out of ' + limit.toLocaleString() : ''}. Click to freeze all refreshes.`) +
      (rate
        ? `\nLast checked ${fullDate(rate.observedAt)}; resets ${fullDate(rate.resetAt)}${stale ? ' (cached window has expired)' : ''}`
        : '');
  }
  const jobs = liveStatus ? [liveStatus.active, ...liveStatus.queued].filter(Boolean) : [];
  const global = jobs.some((j) => j.kind === 'global');
  $('refresh-all').disabled = !!frozen || global || !liveStatus;
  $('refresh-all').textContent = global ? 'Refreshing…' : 'Refresh all';
  for (const b of document.querySelectorAll('[data-refresh-pr]')) {
    const busy = runningFor(workspaceKey, Number(b.dataset.refreshPr));
    b.disabled = !!frozen || busy || !liveStatus;
    b.setAttribute('aria-busy', String(!!busy));
    b.querySelector('.refresh-icon').classList.toggle('spinning', !!busy && !frozen);
    b.title = frozen ? 'Refreshes are frozen' : busy ? 'Refresh in progress' : 'Refresh this PR';
  }
  const job = liveStatus?.active || liveStatus?.queued[0];
  $('refresh-progress').hidden = !job;
  if (job) {
    $('refresh-progress').classList.toggle('paused', !!frozen);
    $('refresh-progress-text').textContent =
      `${frozen ? 'Paused · ' : ''}${job.kind === 'global' ? 'Global refresh' : job.kind === 'pr' ? `Refreshing #${job.number}` : 'API usage'} · ${job.phase}`;
    $('refresh-progress-count').textContent =
      `${job.total ? `${job.completed}/${job.total} · ` : ''}${job.apiCalls} API calls${liveStatus.queued.length ? ` · ${liveStatus.queued.length} queued` : ''}${frozen && liveStatus.inFlightCalls ? ` · ${liveStatus.inFlightCalls} calls finishing` : ''}`;
    $('refresh-progress-bar').value = job.progress;
    $('refresh-progress').title =
      $('refresh-progress-text').textContent + ' · ' + $('refresh-progress-count').textContent;
  }
  $('detail-live-progress').hidden = !job;
  if (job) {
    $('detail-live-progress').textContent = $('refresh-progress').title;
    $('detail-live-progress').title = $('refresh-progress').title;
  }
  const target = currentPreview;
  if (target && $('detail-refresh-state')) {
    const p = bundle.workspaces[target.workspace]?.pullRequests.find(
      (p) => p.number === target.number,
    );
    $('detail-refresh-state').textContent = runningFor(target.workspace, target.number)
      ? frozen
        ? 'Refresh paused'
        : 'Refreshing…'
      : p?.refreshedAt
        ? `Updated ${fullDate(p.refreshedAt)}`
        : '';
  }
}
function applyLiveData(next) {
  if (next.instance === bundle.instance && next.revision < bundle.revision) return;
  const previous = currentPreview && $('detail').open ? { ...currentPreview } : null;
  const scroll = $('detail').scrollTop;
  const opened = [...$('detail').querySelectorAll('details[open]')].map((d) => d.className);
  bundle.workspaces = next.workspaces;
  bundle.revision = next.revision;
  bundle.instance = next.instance;
  liveRevision = `${bundle.instance}:${bundle.revision}`;
  data = bundle.workspaces[workspaceKey];
  prs = data.pullRequests;
  counts = Object.fromEntries(
    queues.map((q) => [q[0], prs.filter((p) => p.queue === q[0]).length]),
  );
  renderWorkspaceChrome();
  syncControls();
  render();
  if (previous && previous.workspace === workspaceKey) {
    if (prs.some((p) => p.number === previous.number)) {
      showDetails(previous.number, { refresh: false });
      for (const d of $('detail').querySelectorAll('details'))
        if (opened.includes(d.className)) d.open = true;
      $('detail').scrollTop = scroll;
    } else {
      $('detail').close();
      liveToast(`#${previous.number} left the active queue.`);
    }
  }
  updateLiveUI();
}
async function pollLiveStatus() {
  if (statusPending) return;
  statusPending = true;
  try {
    liveStatus = await localAPI('/api/status');
    updateLiveUI();
    const revision = `${liveStatus.instance}:${liveStatus.revision}`;
    if (revision !== liveRevision) {
      const next = await localAPI('/api/data');
      applyLiveData(next);
    }
    const finished = [...liveStatus.jobs]
      .reverse()
      .find((j) => j.status === 'done' || j.status === 'failed');
    if (finished && finished.id !== lastJobNotice) {
      lastJobNotice = finished.id;
      if (Date.now() - new Date(finished.completedAt) < 15000 && finished.kind !== 'rate')
        liveToast(
          finished.status === 'failed'
            ? `Refresh failed: ${finished.error}`
            : finished.result?.message || 'Refreshed',
        );
    }
  } catch (error) {
    $('api-usage').textContent = 'Backend offline';
    $('api-usage').title = error.message;
    $('refresh-all').disabled = true;
  } finally {
    statusPending = false;
  }
}
async function refreshPR(workspace, number, reason = 'manual') {
  if (liveStatus?.frozen) {
    if (reason === 'manual') liveToast('Refreshes are frozen. Click the API indicator to resume.');
    return;
  }
  if (reason === 'return') recentReturns.set(prKey(workspace, number), Date.now());
  try {
    await localAPI('/api/refresh-pr', { workspace, number, reason });
    await pollLiveStatus();
  } catch (error) {
    if (reason === 'manual' || !liveStatus?.frozen) liveToast(error.message);
  }
}
function liveOpenedPR(number) {
  clearTimeout(openRefreshTimer);
  const key = prKey(workspaceKey, number);
  if (liveStatus?.frozen || Date.now() - (recentReturns.get(key) || 0) < 2000) return;
  const workspace = workspaceKey;
  openRefreshTimer = setTimeout(() => {
    openRefreshTimer = null;
    if (
      document.visibilityState === 'visible' &&
      currentPreview?.workspace === workspace &&
      currentPreview?.number === number
    )
      refreshPR(workspace, number, 'open');
  }, 350);
}
function markDeparture() {
  clearTimeout(openRefreshTimer);
  openRefreshTimer = null;
  clearTimeout(returnTimer);
  returnTimer = null;
  // Leaving the dashboard alone never schedules a GitHub refresh.
}
function handleReturn() {
  clearTimeout(returnTimer);
  returnTimer = setTimeout(() => {
    if (document.visibilityState !== 'visible') return;
    const targets = [...returnTargets.values()];
    returnTargets.clear();
    for (const target of targets) refreshPR(target.workspace, target.number, 'return');
    pollLiveStatus();
  }, 250);
}
function trackExternalPR(a) {
  if (!a?.matches('#rows a.external, #detail-content a.github-button') || liveStatus?.frozen)
    return;
  const url = new URL(a.href);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return;
  const path = url.pathname.split('/').filter(Boolean);
  const workspace = Object.keys(bundle.workspaces).find(
    (key) => bundle.workspaces[key].repo === path.slice(0, 2).join('/'),
  );
  if (!workspace) return;
  const number = path[2] === 'pull' ? Number(path[3]) : null;
  if (number && bundle.workspaces[workspace].pullRequests.some((p) => p.number === number)) {
    // Each explicit Open PR click permits one refresh on the next return.
    returnTargets.set(prKey(workspace, number), { workspace, number });
    clearTimeout(openRefreshTimer);
    openRefreshTimer = null;
    clearTimeout(returnTimer);
    returnTimer = null;
  }
}
function initLive() {
  $('live-controls').hidden = false;
  $('offline-mode').hidden = true;
  $('refresh-all').onclick = async () => {
    try {
      await localAPI('/api/refresh', {});
      pollLiveStatus();
    } catch (e) {
      liveToast(e.message);
    }
  };
  const toggleFreeze = async () => {
    if (!liveStatus) {
      await pollLiveStatus();
      if (!liveStatus) return;
    }
    try {
      liveStatus = await localAPI('/api/freeze', { frozen: !liveStatus.frozen });
      if (liveStatus.frozen) {
        clearTimeout(openRefreshTimer);
        returnTargets.clear();
      }
      updateLiveUI();
    } catch (e) {
      liveToast(e.message);
    }
  };
  $('api-usage').onclick = toggleFreeze;
  $('detail-api-usage').onclick = toggleFreeze;
  document.addEventListener('click', (event) => {
    const pin = event.target.closest('button[data-pin-pr]');
    if (pin) {
      event.preventDefault();
      changePin(pin);
      return;
    }
    const dismissal = event.target.closest('[data-dismiss-pr]');
    if (dismissal) {
      event.preventDefault();
      changeDismissal(dismissal);
      return;
    }
    const b = event.target.closest('[data-refresh-pr]');
    if (b) {
      event.preventDefault();
      event.stopPropagation();
      refreshPR(workspaceKey, Number(b.dataset.refreshPr), 'manual');
      return;
    }
    trackExternalPR(event.target.closest('a[href]'));
  });
  document.addEventListener('auxclick', (event) => {
    if (event.button === 1) trackExternalPR(event.target.closest('a[href]'));
  });
  $('detail').addEventListener('close', () => {
    if (!$('detail').open) {
      currentPreview = null;
      clearTimeout(openRefreshTimer);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') markDeparture();
    else handleReturn();
  });
  window.addEventListener('blur', markDeparture);
  window.addEventListener('focus', handleReturn);
  updateLiveUI();
  pollLiveStatus();
  setInterval(pollLiveStatus, 2000);
}
