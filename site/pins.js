// Pins and the picker are local state: typing or pinning never requests GitHub data.
const pinPending = new Set();
let pinSearchWorkspace = null;
let pinPickerOpen = false;

function pinIcon() {
  return '<svg class="pin-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l-1 2v4l3 3v2H6v-2l3-3V6z"/><path d="M12 15v6"/></svg>';
}

function renderPinControl(p, { label = false } = {}) {
  if (!bundle.live)
    return p.pinned ? `<span class="pin-control is-pinned" title="Pinned">${pinIcon()}</span>` : '';
  return `<button type="button" class="pin-control ${p.pinned ? 'is-pinned' : ''} ${label ? 'pin-labeled' : ''}" data-pin-pr="${p.number}" data-pinned="${!p.pinned}" aria-pressed="${!!p.pinned}" aria-label="${p.pinned ? 'Unpin' : 'Pin'} PR ${p.number}" title="${p.pinned ? 'Unpin this PR' : 'Pin this PR'}">${pinIcon()}${label ? `<span>${p.pinned ? 'Pinned' : 'Pin'}</span>` : ''}</button>`;
}

function normalizePinSearch(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) {
      i += 2;
      j += 2;
    } else if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length > b.length) i++;
    else j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function pinTermScore(term, text) {
  if (!text) return Infinity;
  if (term === text) return 0;
  const index = text.indexOf(term);
  if (index >= 0) return 5 + (index && text[index - 1] !== ' ' ? 10 : 0) + index / 100;
  let cursor = 0,
    first = -1,
    last = 0;
  for (const char of term) {
    const next = text.indexOf(char, cursor);
    if (next < 0) {
      first = -1;
      break;
    }
    if (first < 0) first = next;
    last = next;
    cursor = next + 1;
  }
  const subsequence = first < 0 ? Infinity : 40 + last - first - term.length + 1;
  const typo = term.length >= 4 && text.split(' ').some((word) => oneEditApart(term, word));
  return Math.min(subsequence, typo ? 35 : Infinity);
}

function findPinMatches(query) {
  const terms = normalizePinSearch(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  return prs
    .map((pr) => {
      const fields = [pr.number, pr.title, pr.author, pr.authorName].map(normalizePinSearch);
      const score = terms.reduce(
        (sum, term) => sum + Math.min(...fields.map((text) => pinTermScore(term, text))),
        0,
      );
      return { pr, score };
    })
    .filter((match) => Number.isFinite(match.score))
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(!!a.pr.pinned) - Number(!!b.pr.pinned) ||
        b.pr.number - a.pr.number,
    );
}

function renderPinPicker() {
  const picker = $('pin-picker');
  picker.hidden = state.view !== 'pinned' || !bundle.live;
  if (pinSearchWorkspace !== workspaceKey) {
    pinSearchWorkspace = workspaceKey;
    $('pin-search').value = '';
    pinPickerOpen = false;
  }
  const query = $('pin-search').value.trim();
  $('pin-results').hidden = picker.hidden || !pinPickerOpen || !query;
  if ($('pin-results').hidden) return;
  const matches = findPinMatches(query);
  $('pin-matches').innerHTML = matches
    .slice(0, 8)
    .map(
      ({ pr }) =>
        `<li><div class="pin-match-info"><span class="pin-match-title">#${pr.number} · ${esc(pr.title)}</span><span class="pin-match-author">@${esc(pr.author || 'deleted-user')}${pr.authorName ? ' · ' + esc(pr.authorName) : ''}</span></div>${renderPinControl(pr, { label: true })}</li>`,
    )
    .join('');
  $('pin-search-status').textContent = matches.length
    ? `${Math.min(matches.length, 8)} of ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}${matches.length > 8 ? ' · Keep typing to narrow' : ''}`
    : 'No matching PRs in this workspace’s indexed pool.';
  if (bundle.live) updatePinControls();
}

function updatePinControls() {
  for (const button of document.querySelectorAll('button[data-pin-pr]')) {
    const pending = pinPending.has(`${workspaceKey}:${button.dataset.pinPr}`);
    button.disabled = pending;
    button.setAttribute('aria-busy', String(pending));
  }
}

async function changePin(button) {
  const workspace = workspaceKey,
    number = Number(button.dataset.pinPr);
  const key = `${workspace}:${number}`;
  if (pinPending.has(key)) return;
  const origin = button.closest('#pin-picker')
    ? 'picker'
    : button.closest('#detail-content')
      ? 'detail'
      : 'row';
  const typing = document.activeElement === $('pin-search');
  pinPending.add(key);
  updatePinControls();
  try {
    const next = await localAPI('/api/pin', {
      workspace,
      number,
      pinned: button.dataset.pinned === 'true',
    });
    applyLiveData(next);
  } catch (error) {
    liveToast(error.message);
    await pollLiveStatus();
  } finally {
    pinPending.delete(key);
    updatePinControls();
    if (workspaceKey === workspace) {
      const container =
        origin === 'picker'
          ? $('pin-picker')
          : origin === 'detail'
            ? $('detail-content')
            : $('rows');
      const target = typing
        ? $('pin-search')
        : container.querySelector(`[data-pin-pr="${number}"]`);
      (target || (state.view === 'pinned' ? $('pin-search') : null))?.focus({
        preventScroll: true,
      });
    }
  }
}

$('pin-search').addEventListener('input', () => {
  pinPickerOpen = true;
  renderPinPicker();
});
$('pin-search').addEventListener('focus', () => {
  pinPickerOpen = true;
  renderPinPicker();
});
$('pin-picker').addEventListener('keydown', (event) => {
  const buttons = [...$('pin-matches').querySelectorAll('button:not(:disabled)')];
  if (event.key === 'Escape') {
    event.preventDefault();
    pinPickerOpen = false;
    $('pin-search').focus();
    pinPickerOpen = false;
    renderPinPicker();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!buttons.length || $('pin-results').hidden) return;
    event.preventDefault();
    const next = buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) $('pin-search').focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  } else if (event.key === 'Enter' && event.target === $('pin-search')) {
    event.preventDefault();
    buttons.find((button) => button.dataset.pinned === 'true')?.click();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#pin-picker')) {
    pinPickerOpen = false;
    renderPinPicker();
  }
});
