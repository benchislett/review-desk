const velocityState = {
  grain: 'week',
  range: '365',
  metric: 'prs',
  selected: null,
  allRows: false,
};
const dayMs = 86400000;
const isoDate = (d) => d.toISOString().slice(0, 10);
const calendarDate = (d) => new Date(d + 'T00:00:00Z');
const shiftDate = (d, n) => isoDate(new Date(+calendarDate(d) + n * dayMs));
const calendarLabel = (d) =>
  calendarDate(d).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
function bucketStart(date, grain) {
  const d = calendarDate(date);
  if (grain === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (grain === 'month') d.setUTCDate(1);
  return isoDate(d);
}
function bucketNext(date, grain) {
  const d = calendarDate(date);
  if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (grain === 'week' ? 7 : 1));
  return isoDate(d);
}
function velocityBuckets(reviews, from, to, grain) {
  const byPeriod = new Map();
  for (let key = bucketStart(from, grain); key <= to; key = bucketNext(key, grain))
    byPeriod.set(key, {
      key,
      end: shiftDate(bucketNext(key, grain), -1),
      reviews: [],
      prs: new Set(),
    });
  for (const r of reviews) {
    if (r.date < from || r.date > to) continue;
    const b = byPeriod.get(bucketStart(r.date, grain));
    b.reviews.push(r);
    b.prs.add(r.number);
  }
  return [...byPeriod.values()];
}
let velocityVisible = [];
function renderVelocity() {
  const v = data.velocity;
  const earliest = v.reviews[0]?.date || v.today;
  const from =
    velocityState.range === 'all' ? earliest : shiftDate(v.today, 1 - Number(velocityState.range));
  const inRange = v.reviews.filter((r) => r.date >= from && r.date <= v.today);
  const distinct = (reviews) => new Set(reviews.map((r) => r.number)).size;
  const scopes = [
    ['Today', v.today],
    ['This week', bucketStart(v.today, 'week')],
    ['This month', bucketStart(v.today, 'month')],
    [
      velocityState.range === 'all' ? 'All collected history' : `Last ${velocityState.range} days`,
      from,
    ],
  ];
  $('velocity-summary').innerHTML = scopes
    .map(([label, start]) => {
      const rr = v.reviews.filter((r) => r.date >= start && r.date <= v.today);
      return `<div class="stat"><span class="stat-top">${label}</span><span class="stat-number">${distinct(rr)}</span><span class="stat-foot">PRs reviewed · ${rr.length} submissions</span></div>`;
    })
    .join('');
  document.querySelectorAll('[data-grain]').forEach((b) => {
    b.classList.toggle('active', b.dataset.grain === velocityState.grain);
    b.setAttribute('aria-pressed', String(b.dataset.grain === velocityState.grain));
  });
  const buckets = velocityBuckets(inRange, from, v.today, velocityState.grain);
  const value = (b) => (velocityState.metric === 'prs' ? b.prs.size : b.reviews.length);
  const max = Math.max(1, ...buckets.map(value));
  const width = Math.max(820, buckets.length * 17 + 65),
    height = 260,
    plotHeight = 185,
    barWidth = (width - 65) / buckets.length;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const rows = [0, Math.ceil(max / 2), max].filter((x, i, a) => a.indexOf(x) === i);
  const axes = rows
    .map((n) => {
      const y = plotHeight + 15 - (n / max) * plotHeight;
      return `<line x1="40" y1="${y}" x2="${width - 10}" y2="${y}" stroke="#e2e8da" stroke-dasharray="3 4"/><text x="30" y="${y + 4}" text-anchor="end" fill="#8a987f" font-size="10">${n}</text>`;
    })
    .join('');
  const bars = buckets
    .map((b, i) => {
      const n = value(b),
        h = Math.max(2, (n / max) * plotHeight),
        x = 45 + i * barWidth,
        y = 15 + plotHeight - h;
      const partial = b.key < from || b.end > v.today;
      const label = `${calendarLabel(b.key)}${velocityState.grain === 'day' ? '' : ' – ' + calendarLabel(b.end)}: ${b.prs.size} distinct PRs, ${b.reviews.length} review submissions${partial ? ' (partial period)' : ''}`;
      return `<g class="velocity-bar" data-bucket="${b.key}" tabindex="0" role="button" aria-label="${esc(label)}" aria-pressed="${velocityState.selected === b.key}"><title>${esc(label)}</title><rect x="${x}" y="${y}" width="${Math.max(3, barWidth - 4)}" height="${h}" rx="2" fill="${velocityState.selected === b.key ? '#b98549' : n ? '#629074' : '#dce5d5'}"/>${i % labelEvery === 0 ? `<text x="${x}" y="225" fill="#8a987f" font-size="9">${b.key.slice(5)}</text>` : ''}</g>`;
    })
    .join('');
  $('velocity-chart').innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="${esc(velocityState.metric === 'prs' ? 'Distinct PRs reviewed' : 'Review submissions')} by ${velocityState.grain}">${axes}${bars}</svg>`;
  $('chart-title').textContent =
    velocityState.metric === 'prs' ? 'Distinct PRs reviewed' : 'Formal review submissions';
  $('chart-caption').textContent =
    `${calendarLabel(from)} – ${calendarLabel(v.today)} · ${distinct(inRange)} PRs / ${inRange.length} submissions`;
  $('velocity-zone').textContent = `Dates use ${v.timezone}; weeks start Monday.`;
  const selected = buckets.find((b) => b.key === velocityState.selected);
  velocityVisible = [...(selected ? selected.reviews : inRange)].reverse();
  $('velocity-clear').hidden = !selected;
  $('velocity-list-title').textContent = selected
    ? `Reviews · ${calendarLabel(selected.key)}`
    : 'Review history';
  $('velocity-list-description').textContent =
    `${distinct(velocityVisible)} distinct PRs · ${velocityVisible.length} submitted reviews${selected && velocityState.grain !== 'day' ? ' · through ' + calendarLabel(selected.end) : ''}`;
  const stateLabel = {
    COMMENTED: 'Comment',
    APPROVED: 'Approved',
    CHANGES_REQUESTED: 'Changes requested',
    DISMISSED: 'Dismissed review',
  };
  $('velocity-rows').innerHTML = velocityVisible
    .slice(0, velocityState.allRows ? Infinity : 50)
    .map(
      (r) =>
        `<tr><td><div class="pr-top"><span class="pr-number">#${r.number}</span><span class="label-pill">${esc(r.prState.toLowerCase())}</span></div>${link(r.prUrl, r.title, 'pr-title')}</td><td><span class="badge ${r.state === 'CHANGES_REQUESTED' ? 'feedback' : r.state === 'APPROVED' ? 'review' : 'waiting'}">${stateLabel[r.state] || esc(r.state)}</span></td><td><span class="age" title="${esc(r.submittedAt)}">${r.date}</span></td><td>${link(r.url, '↗', 'external')}</td></tr>`,
    )
    .join('');
  $('velocity-empty').hidden = velocityVisible.length > 0;
  $('velocity-more').hidden = velocityState.allRows || velocityVisible.length <= 50;
  $('velocity-more').textContent = `Show all ${velocityVisible.length} reviews`;
  $('velocity-footer').textContent =
    `${v.candidateCount} reviewed PRs across all states · Captured ${fullDate(v.completedAt)} · Formal reviews only · Bot activity excluded`;
}
function chooseBucket(e) {
  const bar = e.target.closest('[data-bucket]');
  if (!bar) return;
  if (e.type === 'keydown' && !['Enter', ' '].includes(e.key)) return;
  e.preventDefault();
  velocityState.selected =
    velocityState.selected === bar.dataset.bucket ? null : bar.dataset.bucket;
  velocityState.allRows = false;
  renderVelocity();
}
$('velocity-chart').addEventListener('click', chooseBucket);
$('velocity-chart').addEventListener('keydown', chooseBucket);
for (const b of document.querySelectorAll('[data-grain]'))
  b.onclick = () => {
    velocityState.grain = b.dataset.grain;
    velocityState.selected = null;
    velocityState.allRows = false;
    renderVelocity();
  };
$('velocity-range').onchange = () => {
  velocityState.range = $('velocity-range').value;
  velocityState.selected = null;
  velocityState.allRows = false;
  renderVelocity();
};
$('velocity-metric').onchange = () => {
  velocityState.metric = $('velocity-metric').value;
  renderVelocity();
};
$('velocity-clear').onclick = () => {
  velocityState.selected = null;
  velocityState.allRows = false;
  renderVelocity();
};
$('velocity-more').onclick = () => {
  velocityState.allRows = true;
  renderVelocity();
};
$('velocity-export').onclick = () => {
  const payload = {
    repo: data.repo,
    user: data.user,
    timezone: data.velocity.timezone,
    snapshotAt: data.velocity.completedAt,
    filters: velocityState,
    reviews: velocityVisible,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = data.repo.replace('/', '-') + '-review-velocity.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
