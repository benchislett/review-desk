// Source text is escaped; PR comments and commit messages never become executable HTML.
function previewHeading(p, e) {
  if (e.kind === 'commit') return 'New commit';
  if (e.kind === 'inline') return 'Inline reply';
  if (e.kind === 'review') return 'Submitted review';
  if (e.kind === 'comment') return e.author === p.author ? 'Author reply' : 'Conversation comment';
  if (e.kind === 'review request') return 'Review requested';
  if (e.kind === 'assignment') return 'Assignment';
  return 'PR description';
}
function previewBody(e) {
  if (e.kind === 'commit') {
    const c = e.commit || {};
    if (c.messageHeadline)
      return `<h4 class="commit-subject">${esc(c.messageHeadline)}</h4>${c.messageBody ? `<div class="preview-text commit-message">${esc(c.messageBody)}</div>` : ''}`;
    return `<div class="preview-text commit-message">${esc(e.body || 'Commit message was not captured in this snapshot.')}</div>`;
  }
  if (e.body) return `<div class="preview-text">${esc(e.body)}</div>`;
  const empty = {
    APPROVED: 'Approved without a written comment.',
    CHANGES_REQUESTED:
      'Requested changes without a review summary. See the inline discussion below.',
    COMMENTED: 'Submitted a review without a summary. See the inline discussion below.',
    DISMISSED: 'This review was dismissed.',
  };
  const text =
    e.kind === 'review request'
      ? 'Requested your review.'
      : e.kind === 'assignment'
        ? 'Assigned this PR to you.'
        : empty[e.state] || 'No written message.';
  return `<p class="preview-empty">${esc(text)}</p>`;
}
function previewMeta(e) {
  const state = e.state ? ` · ${e.state.toLowerCase().replaceAll('_', ' ')}` : '';
  return `<div class="preview-meta"><span>${e.author ? '@' + esc(e.author) : 'Unknown author'}${esc(state)} · ${esc(fullDate(e.at))}</span>${link(e.url, 'View on GitHub ↗')}</div>`;
}
function renderSignalPreview(p) {
  const t = p.trigger;
  const line = t.line ?? t.originalLine;
  const location = t.path
    ? `${t.path}${line != null ? ':' + line : ''}${t.line == null && t.originalLine != null ? ' (original line)' : ''}`
    : '';
  const commit = t.kind === 'commit' ? t.commit : null;
  const commitMeta = commit
    ? `<div class="commit-meta">${link(t.url, (commit.oid || '').slice(0, 12))}${commit.author?.name ? `<span>Author: ${esc(commit.author.name)}</span>` : ''}<span>Committed ${esc(fullDate(commit.committedDate || t.at))}</span></div>`
    : '';
  let context = '';
  if (t.kind === 'inline' && t.threadId) {
    const prior = p.events.filter(
      (e) => e.kind === 'inline' && e.threadId === t.threadId && e.id !== t.id && e.at <= t.at,
    );
    if (prior.length)
      context = `<details class="preview-context"><summary>Earlier in this thread · ${prior.length} ${prior.length === 1 ? 'comment' : 'comments'}</summary>${prior.map((e) => `<article class="context-entry">${previewMeta(e)}${previewBody(e)}</article>`).join('')}</details>`;
  }
  const code = t.diffHunk
    ? `<details class="code-context"><summary>Code context${location ? ' · ' + esc(location) : ''}</summary><pre><code>${esc(t.diffHunk)}</code></pre></details>`
    : '';
  const source = t.kind === 'description' ? { ...t, body: p.body } : t;
  return `<section class="signal-preview" aria-label="Activity behind this signal"><h3>${previewHeading(p, t)}</h3>${previewMeta(t)}${location ? `<div class="preview-location">${esc(location)}${t.resolved ? ' · Resolved thread' : ''}${t.outdated ? ' · Outdated diff' : ''}</div>` : ''}${commitMeta}${previewBody(source)}${context}${code}</section>`;
}
function renderLastResponse(p) {
  const last = p.lastResponse;
  if (!last)
    return '<section class="last-response"><h3>Your last response</h3><p>No comment or submitted review from you is recorded.</p></section>';
  return `<details class="last-response"><summary>Your last response · ${esc(fullDate(last.at))}</summary>${previewMeta(last)}${previewBody(last)}</details>`;
}

function renderReadiness(p) {
  const r = p.readiness;
  if (!p.mine && !p.reviewedByMe && !r?.eligible) return '';
  return `<section class="merge-readiness ${p.ready ? 'is-ready' : ''}" aria-label="Merge readiness"><h3>${p.ready ? '✓ Ready to merge' : 'Merge readiness'}</h3><p>${esc(r?.summary || 'Refresh this PR to check approvals and CI.')}</p>${p.refreshedAt ? `<span class="muted">Checked ${esc(fullDate(p.refreshedAt))}</span>` : ''}</section>`;
}
