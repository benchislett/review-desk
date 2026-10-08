'use strict';
const bundle = JSON.parse(document.getElementById('snapshot').textContent);
let workspaceKey = bundle.defaultWorkspace;
let data = bundle.workspaces[workspaceKey];
let prs = data.pullRequests;
const queues = bundle.queues;
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const safeURL = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'github.com'
      ? u.href
      : 'https://github.com/' + data.repo;
  } catch {
    return 'https://github.com/' + data.repo;
  }
};
const link = (url, label, cls = 'evidence-link') =>
  `<a class="${cls}" href="${esc(safeURL(url))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const names = Object.fromEntries(queues.map((q) => [q[0], q[1]]));
const rank = Object.fromEntries(queues.map((q, i) => [q[0], i]));
const shortNames = {
  direct: 'Unanswered mention',
  feedback: 'Author action',
  followup: 'Review follow-up',
  review: 'Review requested',
  assigned: 'Assigned to you',
  waiting: 'Waiting on others',
  watching: 'Following',
};
const colors = ['#c67c58', '#c4a153', '#7d97bc', '#8fa775', '#a78eb5', '#aab29e', '#c2c8b9'];
let counts = Object.fromEntries(
  queues.map((q) => [q[0], prs.filter((p) => p.queue === q[0]).length]),
);
const fullDate = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'No response recorded';
const shortDate = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const age = (value) => {
  const hours = Math.max(
    0,
    Math.floor(
      ((bundle.live ? new Date() : new Date(data.completedAt)) - new Date(value)) / 3600000,
    ),
  );
  return hours < 24 ? (hours === 0 ? '<1h' : `${hours}h`) : `${Math.floor(hours / 24)}d`;
};
let state = defaultState(workspaceKey);
let visible = [];
function currentApproval(reviews, user) {
  const decisions = new Map();
  for (const review of reviews) {
    const author = typeof review.author === 'string' ? review.author : review.author?.login;
    const at = review.submittedAt || (review.kind === 'review' ? review.at : null);
    if (
      author?.toLowerCase() !== user.toLowerCase() ||
      review.isBot ||
      review.author?.__typename === 'Bot' ||
      !at
    )
      continue;
    if (review.kind && review.kind !== 'review') continue;
    // A subsequent Comment review leaves the previous decision in place.
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    decisions.set(review.url || review.id, {
      id: review.id || review.url,
      at,
      url: review.url,
      state: review.state,
    });
  }
  const latest = [...decisions.values()]
    .sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)))
    .at(-1);
  return latest?.state === 'APPROVED' ? latest : null;
}
function approvalIndex() {
  const history = new Map();
  for (const review of data.velocity?.reviews || []) {
    if (!history.has(review.number)) history.set(review.number, []);
    history.get(review.number).push(review);
  }
  const approvals = new Map();
  for (const p of prs) {
    if (p.state && p.state !== 'OPEN') continue;
    const current = (p.readiness?.approvals || []).map((r) => ({
      ...r,
      kind: 'review',
      state: 'APPROVED',
    }));
    // Reuse formal history as well as discussion events, so a /ci-only review
    // can still carry an approval without becoming a discussion signal.
    const approval = currentApproval(
      [...current, ...(p.events || []), ...(history.get(p.number) || [])],
      data.user,
    );
    if (approval) approvals.set(p.number, approval);
  }
  return approvals;
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const key = params.get('workspace') || bundle.defaultWorkspace;
  activateWorkspace(key);
  state = defaultState(workspaceKey);
  for (const name of Object.keys(state))
    if (name !== 'workspace' && params.has(name)) state[name] = params.get(name);
  if (state.sort === 'priority') state.sort = 'signal';
  if (
    ![
      'all',
      'mine',
      'pinned',
      'approved',
      'ready',
      'commented',
      'velocity',
      ...queues.map((q) => q[0]),
    ].includes(state.view)
  )
    state.view = data.defaultView;
  if (state.view === 'velocity' && !data.velocity) state.view = data.defaultView;
  if (data.poolScope === 'authored-commented') state.involvement = 'all';
  if (!['replies', 'all'].includes(state.followup)) state.followup = 'replies';
  syncControls();
}

function saveHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
  history.replaceState(null, '', '#' + p.toString());
}
function badge(p, mergeReady = false) {
  if (mergeReady) return '<span class="badge ready">Ready to merge</span>';
  return `<span class="badge ${p.queue}">${esc(p.dismissal ? 'Dismissed' : shortNames[p.queue])}</span>`;
}
function navItem(view, title, count, symbol, color) {
  return `<button class="nav-item ${state.view === view ? 'active' : ''}" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${color ? `<span class="queue-dot" style="--queue-color:${color}" aria-hidden="true"></span>` : `<span class="nav-symbol" aria-hidden="true">${symbol}</span>`}<span>${esc(title)}</span><span class="count">${count}</span></button>`;
}
function setView(view) {
  if (view === 'velocity' && !data.velocity) view = data.defaultView;
  state.view = view;
  saveHash();
  render();
}
function render() {
  const approvals = approvalIndex();
  $('workspace').innerHTML =
    navItem('all', 'All pull requests', prs.length, '▤') +
    navItem('mine', 'My PRs', prs.filter((p) => p.mine).length, '⌘') +
    navItem('pinned', 'Pinned', prs.filter((p) => p.pinned).length, pinIcon()) +
    navItem('approved', 'Approved', approvals.size, '✓') +
    navItem('ready', 'Ready', prs.filter((p) => p.ready).length, '✓') +
    (data.poolScope === 'authored-commented'
      ? navItem(
          'commented',
          'Commented on',
          prs.filter((p) => p.reasons.includes('Commenter')).length,
          '↩',
        )
      : '') +
    (data.velocity ? navItem('velocity', 'Review velocity', '↗', '▥') : '');
  $('queues').innerHTML = queues
    .map((q, i) =>
      data.poolScope === 'authored-commented' && !counts[q[0]]
        ? ''
        : navItem(q[0], q[1], counts[q[0]], '', colors[i]),
    )
    .join('');
  for (const card of $('stats').querySelectorAll('[data-view]')) {
    const active = card.dataset.view === state.view;
    card.classList.toggle('active', active);
    if (active) card.setAttribute('aria-current', 'page');
    else card.removeAttribute('aria-current');
  }
  renderPinPicker();
  const velocityView = state.view === 'velocity';
  document.querySelector('main>.heading').hidden = velocityView;
  $('stats').hidden = velocityView;
  document.querySelector('.queue-section').hidden = velocityView;
  $('velocity').hidden = !velocityView;
  if (velocityView) {
    renderVelocity();
    return;
  }
  const info = queues.find((q) => q[0] === state.view);
  $('view-title').textContent =
    state.view === 'all'
      ? 'All pull requests'
      : state.view === 'pinned'
        ? 'Pinned pull requests'
        : state.view === 'mine'
          ? 'My pull requests'
          : state.view === 'ready'
            ? 'Ready to merge'
            : state.view === 'approved'
              ? 'Approved by me'
              : state.view === 'commented'
                ? 'Commented-on pull requests'
                : info[1];
  $('view-description').textContent =
    state.view === 'all'
      ? data.poolScope === 'authored-commented'
        ? 'Open PRs you opened or commented on.'
        : 'Open PRs involving you.'
      : state.view === 'pinned'
        ? 'PRs you pinned for easy access.'
        : state.view === 'mine'
          ? `Open PRs you authored in ${data.repo}.`
          : state.view === 'commented'
            ? 'Open PRs with your conversation, inline, or written review comments.'
            : state.view === 'ready'
              ? 'PRs you authored or formally reviewed, with maintainer approval, passing checks, and a clean merge.'
              : state.view === 'approved'
                ? 'Open PRs with your current approval, including those still waiting on CI or merge.'
                : info[2];
  const followupView = state.view === 'followup';
  const hideCommits = followupView && state.followup === 'replies';
  const commitOnlyCount = prs.filter(
    (p) => p.queue === 'followup' && p.trigger.kind === 'commit',
  ).length;
  $('followup-filter').hidden = !followupView;
  $('hide-commit-updates').checked = state.followup === 'replies';
  $('followup-filter-note').textContent = hideCommits
    ? `${commitOnlyCount} PRs hidden · Replies and explicit review re-requests stay visible`
    : 'Showing replies, review re-requests, and newer commits';
  const query = state.q.toLowerCase().trim();
  visible = prs.filter(
    (p) =>
      (state.view === 'all' ||
        (state.view === 'pinned'
          ? p.pinned
          : state.view === 'mine'
            ? p.mine
            : state.view === 'ready'
              ? p.ready
              : state.view === 'approved'
                ? approvals.has(p.number)
                : state.view === 'commented'
                  ? p.reasons.includes('Commenter')
                  : p.queue === state.view)) &&
      (state.involvement === 'all' ||
        (state.involvement === 'reviewer-mentioned'
          ? p.reasons.some((r) => r === 'Reviewer' || r.endsWith('mention'))
          : state.involvement === 'reviewer'
            ? p.reasons.includes('Reviewer')
            : state.involvement === 'mentioned'
              ? p.reasons.some((r) => r.endsWith('mention'))
              : p.reasons.includes('Assignee'))) &&
      (!hideCommits || p.trigger.kind !== 'commit') &&
      (!state.author || p.author === state.author) &&
      (!state.label || p.labels.includes(state.label)) &&
      (state.drafts === 'all' || (state.drafts === 'draft' ? p.isDraft : !p.isDraft)) &&
      (!query ||
        `${p.title} #${p.number} ${p.author} ${p.authorName || ''} ${p.labels.join(' ')}`
          .toLowerCase()
          .includes(query)),
  );
  visible.sort((a, b) =>
    state.sort === 'newest'
      ? b.activityAt.localeCompare(a.activityAt) || b.number - a.number
      : state.sort === 'oldest'
        ? a.trigger.at.localeCompare(b.trigger.at) || a.number - b.number
        : (state.sort === 'priority-newest' ? rank[a.queue] - rank[b.queue] : 0) ||
          b.trigger.at.localeCompare(a.trigger.at) ||
          b.number - a.number,
  );
  $('result-count').textContent =
    `${visible.length} ${visible.length === 1 ? 'pull request' : 'pull requests'}${visible.length !== prs.length ? ` · ${prs.length} in your pool` : ''}`;
  $('reset').hidden =
    !state.q &&
    !state.author &&
    !state.label &&
    state.drafts === 'all' &&
    state.involvement === 'all' &&
    !hideCommits;
  $('rows').innerHTML = visible
    .map(
      (p) =>
        `<tr><td><div class="pr-top"><span class="pr-number">#${p.number}</span><span>by ${esc(p.author || 'deleted-user')}</span>${p.mine ? '<span class="label-pill">Yours</span>' : ''}${p.ready ? '<span class="ready-pill">Ready</span>' : ''}${p.isDraft ? '<span class="draft-pill">Draft</span>' : ''}${p.labels
          .slice(0, 1)
          .map((l) => `<span class="label-pill">${esc(l)}</span>`)
          .join(
            '',
          )}</div><button class="pr-title" data-pr="${p.number}" aria-label="View details for PR ${p.number}: ${esc(p.title)}">${esc(p.title)}</button><div class="pr-reason">${esc(state.view === 'ready' ? p.readiness.summary : state.view === 'approved' ? `You approved ${shortDate(approvals.get(p.number).at)} · ${p.readiness?.summary || p.reason}` : p.reason)}</div></td><td>${state.view === 'approved' ? '<span class="badge approved">Approved by you</span>' : badge(p, state.view === 'ready')}<div class="responsibility">${esc(state.view === 'ready' ? 'Merge on GitHub' : state.view === 'approved' ? 'Awaiting merge' : p.responsibility)}${!['ready', 'approved'].includes(state.view) && p.confidence === 'inferred' ? ' · inferred' : ''}</div></td><td><span class="age" title="${esc(fullDate(p.trigger.at))}">${age(p.trigger.at)}</span><span class="date-small">${shortDate(p.trigger.at)}</span></td><td><div class="row-actions">${renderPinControl(p)}${bundle.live ? `<button class="row-refresh" data-refresh-pr="${p.number}" aria-label="Refresh PR ${p.number}" title="Refresh this PR"><span class="refresh-icon" aria-hidden="true">↻</span></button>` : ''}<a class="external" href="${esc(safeURL(p.url))}" target="_blank" rel="noopener noreferrer" aria-label="Open PR ${p.number} on GitHub">↗</a></div></td></tr>`,
    )
    .join('');
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h3').textContent =
    state.view === 'pinned'
      ? prs.some((p) => p.pinned)
        ? 'No pins match your filters'
        : 'No pinned PRs yet'
      : state.view === 'ready'
        ? 'No PRs ready to merge'
        : state.view === 'approved'
          ? 'No open PRs with your approval'
          : 'Nothing in this view';
  $('empty').querySelector('p').textContent =
    state.view === 'pinned'
      ? prs.some((p) => p.pinned)
        ? 'Clear your filters to see all pinned PRs.'
        : bundle.live
          ? 'Use the search above or a PR’s pin button to add one.'
          : 'Open the live dashboard to pin PRs.'
      : state.view === 'ready'
        ? 'PRs need a maintainer approval, passing checks, and a clean merge.'
        : state.view === 'approved'
          ? 'Approved PRs stay here until they close, merge, or your approval is superseded or dismissed.'
          : 'Try another queue or clear your filters.';
  $('rows').closest('table').hidden = !visible.length;
  if (bundle.live) updateLiveUI();
}
function showDetails(number, { refresh = true } = {}) {
  const p = prs.find((p) => p.number === number);
  if (!p) return;
  $('detail-number').textContent = `${data.repo} · PR #${p.number}`;
  $('detail-content').innerHTML =
    `<div class="detail-status">${badge(p)}<div class="detail-status-actions">${renderPinControl(p, { label: true })}${bundle.live ? renderDismissalControl(p) : ''}</div></div><h2 id="detail-title">${esc(p.title)}</h2><div class="detail-meta">Opened by <b>${esc(p.author)}</b>${p.authorName ? ` · ${esc(p.authorName)}` : ''} · ${esc(fullDate(p.createdAt))}${p.isDraft ? ' · Draft' : ''}<br>In your pool: ${esc(p.reasons.join(' · '))}<br>${p.changedFiles} files · +${p.additions} / −${p.deletions}</div>${link(p.url, 'Open pull request ↗', 'github-button')}${bundle.live ? ` <button class="secondary-button" data-refresh-pr="${p.number}" aria-label="Refresh PR ${p.number}"><span class="refresh-icon" aria-hidden="true">↻</span> Refresh</button><span class="detail-refresh-state" id="detail-refresh-state"></span>` : ''}${renderReadiness(p)}${renderSignalPreview(p)}<section class="evidence"><span class="eyebrow">WHY THIS IS HERE · ${esc(p.confidence.toUpperCase())}</span><h3>Next move: ${esc(p.responsibility)}</h3><p>${esc(p.reason)}</p>${p.dismissal ? `<p class="dismissed-source">Automatic priority: ${esc(shortNames[p.dismissal.automaticQueue])}</p>` : ''}</section>${renderLastResponse(p)}<details><summary>PR description</summary><div class="description">${esc(p.body || 'No description.')}</div></details><h3>Discussion <span class="muted">· ${p.events.length} entries</span></h3><p>Conversation comments, inline comments, and submitted reviews. Newest first.</p><div id="timeline" class="timeline"></div><button id="show-all" class="secondary-button" ${p.events.length <= 40 ? 'hidden' : ''}>Show all ${p.events.length} entries</button>`;
  function timeline(all = false) {
    $('timeline').innerHTML =
      [...p.events]
        .reverse()
        .slice(0, all ? p.events.length : 40)
        .map(
          (e) =>
            `<article class="event"><div class="event-meta"><span><b>${esc(e.author || 'deleted-user')}</b> · ${esc(e.kind)}${e.state ? ' · ' + esc(e.state.toLowerCase().replaceAll('_', ' ')) : ''}${e.resolved ? ' · resolved' : ''}</span>${link(e.url, shortDate(e.at))}</div><div class="event-body">${esc(e.body || `[${e.state || 'No text'}]`)}</div></article>`,
        )
        .join('') || '<p>No discussion yet.</p>';
  }
  timeline();
  $('show-all').onclick = () => {
    timeline(true);
    $('show-all').hidden = true;
  };
  if (!$('detail').open) $('detail').showModal();
  if (bundle.live) {
    currentPreview = { workspace: workspaceKey, number };
    updateLiveUI();
    if (refresh) liveOpenedPR(number);
  }
}
for (const id of ['workspace', 'queues', 'stats'])
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
$('rows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pr]');
  if (b) showDetails(Number(b.dataset.pr));
});
$('search').addEventListener('input', () => {
  state.q = $('search').value;
  saveHash();
  render();
});
for (const id of ['author', 'label', 'involvement', 'drafts', 'sort'])
  $(id).addEventListener('change', () => {
    state[id] = $(id).value;
    saveHash();
    render();
  });
function reset() {
  Object.assign(state, {
    q: '',
    author: '',
    label: '',
    involvement: 'all',
    drafts: 'all',
    followup: 'all',
  });
  $('search').value = '';
  $('author').value = '';
  $('label').value = '';
  $('drafts').value = 'all';
  $('involvement').value = 'all';
  saveHash();
  render();
}
$('hide-commit-updates').addEventListener('change', () => {
  state.followup = $('hide-commit-updates').checked ? 'replies' : 'all';
  saveHash();
  render();
});
$('reset').onclick = reset;
$('empty-reset').onclick = reset;
$('rules-button').onclick = () => $('rules').showModal();
for (const d of document.querySelectorAll('dialog')) {
  d.querySelector('.close').onclick = () => d.close();
  d.addEventListener('click', (e) => {
    const r = d.getBoundingClientRect();
    if (
      e.target === d &&
      (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    )
      d.close();
  });
}
document.addEventListener('keydown', (e) => {
  if (
    e.key === '/' &&
    !document.querySelector('dialog[open]') &&
    !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    $('search').focus();
  }
});
window.addEventListener('hashchange', () => {
  readHash();
  render();
});
$('export').onclick = () => {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          repo: data.repo,
          user: data.user,
          snapshotAt: data.completedAt,
          filters: state,
          pullRequests: visible,
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.repo.replace('/', '-')}-queue-${state.view}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function renderWorkspaceChrome() {
  document.querySelector('.avatar').textContent = data.user.slice(0, 2).toUpperCase();
  $('identity').innerHTML = `<b>@${esc(data.user)}</b><small>${esc(data.role)}</small>`;
  $('workspace-select').value = workspaceKey;
  $('repo-mark').textContent = data.workspaceLabel[0];
  $('workspace-role').textContent = data.role + ' workspace';
  $('workspace-breadcrumb').textContent = data.workspaceLabel;
  document.title = 'Review Desk · ' + data.workspaceLabel;
  $('involvement').hidden = data.poolScope === 'authored-commented';
  $('snapshot-meta').textContent =
    `${bundle.live ? 'Global update' : 'Captured'} ${fullDate(data.completedAt)} · ${prs.length} relevant PRs`;
  if (data.lastItemRefreshAt)
    $('snapshot-meta').title = `Latest individual PR refresh: ${fullDate(data.lastItemRefreshAt)}`;
  $('coverage').textContent =
    `${data.scannedCount.toLocaleString()} ${data.collectionMode === 'exhaustive' ? 'open' : 'matching'} PRs scanned · All discussion pages included${data.lastExhaustiveScannedCount ? ' · Full discovery: ' + data.lastExhaustiveScannedCount.toLocaleString() + ' open PRs' : ''}`;
  $('rules-coverage').textContent =
    `Open PRs only in ${data.repo}, for @${data.user}. Read ${data.scannedCount.toLocaleString()} PRs between ${fullDate(data.startedAt)} and ${fullDate(data.completedAt)}. Includes author, current and historical reviewer/assignee involvement, description mentions, conversation comments, submitted reviews, and inline comments. This is a collection interval, not an atomic point-in-time snapshot; activity after a PR was read is not reflected. Closed and merged PRs are outside this active review queue.${data.collectionMode === 'targeted' ? ' Discovery used targeted GitHub searches plus previously known PRs. New inline-only and review-summary mentions may require an exhaustive audit.' : ''}`;
  if (data.poolScope === 'authored-commented')
    $('rules-coverage').textContent =
      `Open PRs in ${data.repo} for @${data.user}, discovered only with author:${data.user} and commenter:${data.user} searches. Read ${data.scannedCount} matching PRs between ${fullDate(data.startedAt)} and ${fullDate(data.completedAt)}. No repository crawl, reviewer discovery, or review-velocity collection was performed. Inline-only comments absent from GitHub's commenter search may not be discovered. Closed and merged PRs are excluded.`;
  $('rule-list').innerHTML = queues
    .map((q, i) => `<div class="rule"><h3>${i + 1}. ${esc(q[1])}</h3><p>${esc(q[2])}</p></div>`)
    .join('');
  const cards =
    data.poolScope === 'authored-commented'
      ? [
          ['mine', 'My pull requests', prs.filter((p) => p.mine).length, 'Open PRs you authored'],
          [
            'commented',
            'Commented on',
            prs.filter((p) => p.reasons.includes('Commenter')).length,
            'PRs with your comments',
          ],
          ['direct', 'Direct mentions', counts.direct, 'Awaiting your response'],
          ['feedback', 'Author feedback', counts.feedback, 'Feedback on your PRs'],
        ]
      : [
          ['direct', 'Direct mentions', counts.direct, 'Awaiting your response'],
          ['followup', 'Another look', counts.followup, 'Replies & review follow-ups'],
          [
            'mine',
            'My pull requests',
            prs.filter((p) => p.mine).length,
            `${counts.feedback} with author action`,
          ],
          ['review', 'Review requests', counts.review, 'Routine · when you have time'],
        ];
  $('stats').innerHTML = cards
    .map(
      ([v, t, n, f]) =>
        `<button class="stat" data-view="${v}"><span class="stat-top">${esc(t)}<span class="stat-arrow">↗</span></span><span class="stat-number">${n.toString().padStart(2, '0')}</span><span class="stat-foot">${esc(f)}</span></button>`,
    )
    .join('');
  for (const id of ['author', 'label'])
    $(id).replaceChildren(new Option(id === 'author' ? 'All authors' : 'All labels', ''));
  for (const [id, values] of [
    ['author', [...new Set(prs.map((p) => p.author))]],
    ['label', [...new Set(prs.flatMap((p) => p.labels))]],
  ])
    for (const v of values.sort()) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      $(id).append(o);
    }
}
