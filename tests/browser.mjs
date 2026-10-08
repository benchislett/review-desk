// Dependency-free Chrome DevTools smoke test. Requires Chrome and Node 22+.
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = resolve(root, '.tmp/chrome-' + Date.now());
await mkdir(profile, { recursive: true });
execFileSync(process.env.PYTHON || 'python3', [root + '/tests/fixtures.py', profile + '/fixture']);
const chrome = spawn(
  process.env.CHROME_BIN || '/usr/bin/google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--user-data-dir=' + profile,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let ws,
  counter = 0;
const pending = new Map(),
  errors = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (await readFile(profile + '/DevToolsActivePort', 'utf8')).split('\n')[0];
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert(port, 'Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(m.error);
      else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++counter;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: pathToFileURL(profile + '/fixture/index.html').href });
  for (let i = 0; i < 100; i++) {
    if (await run("!!document.querySelector('#rows tr')")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const total = await run('prs.length');
  assert(total > 0);
  const approvalCases = await run(`(()=>{
    const make=(id,state,day,extra={})=>({id,kind:'review',author:'test-reviewer',at:'2026-10-'+String(day).padStart(2,'0')+'T12:00:00Z',state,url:'https://github.com/vllm-project/vllm/pull/1#'+id,...extra});
    const approval=make('approval','APPROVED',1);
    return {
      approval:currentApproval([approval],'test-reviewer')?.id,
      laterComment:currentApproval([approval,make('comment','COMMENTED',2)],'test-reviewer')?.id,
      pending:currentApproval([approval,make('pending','PENDING',3)],'test-reviewer')?.id,
      changes:currentApproval([approval,make('changes','CHANGES_REQUESTED',2)],'test-reviewer'),
      dismissed:currentApproval([approval,{...approval,state:'DISMISSED'}],'test-reviewer'),
      approvedAgain:currentApproval([approval,make('changes','CHANGES_REQUESTED',2),make('again','APPROVED',3)],'test-reviewer')?.id,
      ordinary:currentApproval([{...approval,kind:'comment'}],'test-reviewer'),
      otherReviewer:currentApproval([{...approval,author:'someone-else'}],'test-reviewer'),
      bot:currentApproval([{...approval,author:{login:'test-reviewer',__typename:'Bot'}}],'test-reviewer'),
      rawReview:currentApproval([{id:'raw',author:{login:'Test-reviewer'},submittedAt:approval.at,state:'APPROVED',url:approval.url}],'test-reviewer')?.id
    };
  })()`);
  assert.deepEqual(approvalCases, {
    approval: 'approval',
    laterComment: 'approval',
    pending: 'approval',
    changes: null,
    dismissed: null,
    approvedAgain: 'again',
    ordinary: null,
    otherReviewer: null,
    bot: null,
    rawReview: 'raw',
  });
  await run("document.querySelector('#workspace [data-view=approved]').click()");
  const approvedCount = await run('approvalIndex().size');
  assert.equal(await run('visible.length'), approvedCount);
  assert.equal(
    await run("document.querySelectorAll('#rows .badge.approved').length"),
    approvedCount,
  );
  assert.equal(await run("document.querySelector('#view-title').textContent"), 'Approved by me');
  await run('readHash();render()');
  assert.equal(await run('state.view'), 'approved');
  const approvedShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/approved.png', Buffer.from(approvedShot.data, 'base64'));
  await run("setView('all')");

  assert.equal(await run("document.querySelectorAll('#rows tr').length"), total);
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'), false);
  await run("document.querySelector('[data-view=direct]').click()");
  assert.equal(
    await run("document.querySelectorAll('#rows tr').length"),
    await run('counts.direct'),
  );
  await run("setView('followup')");
  const followups = await run("prs.filter(p=>p.queue==='followup').length");
  const commitOnly = await run(
    "prs.filter(p=>p.queue==='followup'&&p.trigger.kind==='commit').length",
  );
  assert(commitOnly > 0, 'Fixture must include commit-only follow-ups');
  assert.equal(await run("document.querySelector('#hide-commit-updates').checked"), true);
  assert.equal(await run('visible.length'), followups - commitOnly);
  assert(await run("visible.every(p=>p.trigger.kind!=='commit')"));
  await run("document.querySelector('#hide-commit-updates').click()");
  assert.equal(await run('visible.length'), followups);
  await run('readHash();render()');
  assert.equal(await run("document.querySelector('#hide-commit-updates').checked"), false);
  await run("document.querySelector('#hide-commit-updates').click();setView('all')");
  assert.equal(await run('visible.length'), total);
  assert.equal(await run("document.querySelector('#followup-filter').hidden"), true);
  await run("setView('followup');document.querySelector('#reset').click()");
  assert.equal(await run('visible.length'), followups);
  await run("setView('all')");
  await run("document.querySelector('[data-view=mine]').click()");
  assert.equal(
    await run("document.querySelectorAll('#rows tr').length"),
    await run('prs.filter(p=>p.mine).length'),
  );
  await run(
    "setView('all');document.querySelector('#search').value='__no_such_pr__';document.querySelector('#search').dispatchEvent(new Event('input'))",
  );
  assert.equal(await run("document.querySelector('#empty').hidden"), false);
  await run(
    "document.querySelector('#empty-reset').click();document.querySelector('[data-pr]').click()",
  );
  assert.equal(await run("document.querySelector('#detail').open"), true);
  assert(
    await run(
      "document.querySelector('#detail-content').textContent.includes('Your last response')",
    ),
  );
  assert(await run("document.querySelector('.signal-preview')!==null"));
  await run(
    "document.querySelector('#detail').close();showDetails(prs.find(p=>p.trigger.kind==='commit').number)",
  );
  assert.equal(
    await run("document.querySelector('.commit-subject').textContent"),
    await run("prs.find(p=>p.trigger.kind==='commit').trigger.commit.messageHeadline"),
  );
  assert(
    await run(
      "document.querySelector('.commit-meta').textContent.includes(prs.find(p=>p.trigger.kind==='commit').trigger.commit.author.name)",
    ),
  );
  assert(
    await run(
      "document.querySelector('.signal-preview').textContent.includes(prs.find(p=>p.trigger.kind==='commit').trigger.commit.messageBody)",
    ),
  );
  const commitShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/commit-preview.png', Buffer.from(commitShot.data, 'base64'));
  await run(
    "document.querySelector('#detail').close();showDetails(prs.find(p=>p.trigger.kind==='inline'&&p.trigger.threadId&&p.events.some(e=>e.threadId===p.trigger.threadId&&e.id!==p.trigger.id&&e.at<=p.trigger.at)).number)",
  );
  assert(await run("document.querySelector('.preview-location').textContent.length>0"));
  assert(
    await run(
      "document.querySelector('.preview-context .context-entry .preview-text').textContent.length>0",
    ),
  );
  assert(await run("document.querySelector('.code-context code').textContent.length>0"));
  await run("document.querySelector('.preview-context').open=true");
  const replyShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/reply-preview.png', Buffer.from(replyShot.data, 'base64'));

  await run(
    "document.querySelector('#detail .close').click();document.querySelector('#rules-button').click()",
  );
  assert(await run("document.querySelector('#rules').open"));
  await run(
    "document.querySelector('#rules .close').click();document.querySelector('#drafts').value='ready';document.querySelector('#drafts').dispatchEvent(new Event('change'))",
  );
  assert(await run('visible.every(p=>!p.isDraft)'));
  await run(
    "reset();document.querySelector('#involvement').value='reviewer-mentioned';document.querySelector('#involvement').dispatchEvent(new Event('change'))",
  );
  assert(await run("visible.every(p=>p.reasons.some(r=>r==='Reviewer'||r.endsWith('mention')))"));
  await run(
    "reset();document.querySelector('#author').value=prs[0].author;document.querySelector('#author').dispatchEvent(new Event('change'))",
  );
  assert(await run("visible.every(p=>p.author===document.querySelector('#author').value)"));
  await run(
    "reset();document.querySelector('#sort').value='oldest';document.querySelector('#sort').dispatchEvent(new Event('change'))",
  );
  assert(await run('visible.every((p,i)=>!i||visible[i-1].trigger.at<=p.trigger.at)'));
  await run("state.sort='signal';document.querySelector('#sort').value='signal';render()");
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/desktop.png', Buffer.from(shot.data, 'base64'));
  await run("setView('velocity')");
  assert.equal(await run("document.querySelector('#velocity').hidden"), false);
  assert.equal(
    await run("document.querySelector('#velocity .heading h1').textContent"),
    'Review velocity',
  );
  assert(
    await run("document.querySelector('#velocity .heading').getBoundingClientRect().height<70"),
  );
  assert.equal(await run("document.querySelector('.queue-section').hidden"), true);
  assert(await run("document.querySelectorAll('.velocity-bar').length>0"));
  assert.equal(await run("bucketStart('2026-10-04','week')"), '2026-09-28');
  assert.equal(await run("bucketStart('2026-10-05','week')"), '2026-10-05');
  assert.equal(await run("bucketNext('2024-02-01','month')"), '2024-03-01');
  assert.deepEqual(
    await run(
      "velocityBuckets([{date:'2026-10-01',number:1},{date:'2026-10-01',number:1},{date:'2026-10-02',number:1},{date:'2026-10-02',number:2}],'2026-10-01','2026-10-03','day').map(b=>[b.prs.size,b.reviews.length])",
    ),
    [
      [1, 2],
      [2, 2],
      [0, 0],
    ],
  );
  assert.deepEqual(
    await run(
      "velocityBuckets([{date:'2026-10-01',number:1},{date:'2026-10-02',number:1}],'2026-10-01','2026-10-03','month').map(b=>[b.prs.size,b.reviews.length])",
    ),
    [[1, 2]],
  );
  await run(
    "document.querySelector('[data-grain=month]').click();document.querySelector('.velocity-bar').dispatchEvent(new MouseEvent('click',{bubbles:true}))",
  );
  assert.equal(await run("document.querySelector('#velocity-clear').hidden"), false);
  await run(
    "document.querySelector('#velocity-clear').click();document.querySelector('#velocity-metric').value='submissions';document.querySelector('#velocity-metric').dispatchEvent(new Event('change'))",
  );
  assert.equal(
    await run("document.querySelector('#chart-title').textContent"),
    'Formal review submissions',
  );
  const velocityShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/velocity.png', Buffer.from(velocityShot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'), false);
  await run("document.querySelector('[data-grain=day]').click()");
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'), false);
  await run("setView('all')");

  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'), false);
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/mobile.png', Buffer.from(mobile.data, 'base64'));
  // Workspace switching must not mix repos, search filters, counts, or PR links.
  await run(
    "document.querySelector('#search').value='__vllm_filter__';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('#workspace-select').value='flashinfer';document.querySelector('#workspace-select').dispatchEvent(new Event('change'))",
  );
  assert.equal(await run('data.repo'), 'flashinfer-ai/flashinfer');
  assert.equal(await run('state.view'), 'mine');
  assert.equal(await run('state.q'), '');
  assert.equal(
    await run('prs.length'),
    await run('bundle.workspaces.flashinfer.pullRequests.length'),
  );
  assert.equal(await run('visible.length'), await run('prs.filter(p=>p.mine).length'));
  assert(await run('visible.every(p=>p.mine)'));
  assert(
    await run("visible.every(p=>p.url.startsWith('https://github.com/flashinfer-ai/flashinfer/'))"),
  );
  assert.equal(await run("document.querySelector('[data-view=velocity]')===null"), true);
  assert(await run("location.hash.includes('workspace=flashinfer')"));
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'), false);
  const flashMobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/flashinfer-mobile.png', Buffer.from(flashMobile.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const flashDesktop = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/flashinfer.png', Buffer.from(flashDesktop.data, 'base64'));
  await run("setView('commented')");
  assert.equal(
    await run('visible.length'),
    await run("prs.filter(p=>p.reasons.includes('Commenter')).length"),
  );
  assert(await run("visible.every(p=>p.reasons.includes('Commenter'))"));
  await run("setView('all')");
  assert.equal(await run('visible.length'), await run('prs.length'));
  await run('showDetails(prs[0].number)');
  assert(
    await run(
      "document.querySelector('#detail-number').textContent.includes('flashinfer-ai/flashinfer')",
    ),
  );
  assert(
    await run(
      "document.querySelector('.github-button').href.startsWith('https://github.com/flashinfer-ai/flashinfer/')",
    ),
  );
  await run("document.querySelector('#detail').close();readHash();render()");
  assert.equal(await run('data.repo'), 'flashinfer-ai/flashinfer');
  assert.equal(await run('visible.length'), await run('prs.length'));
  await run("switchWorkspace('vllm')");
  assert.equal(await run('data.repo'), 'vllm-project/vllm');
  assert.equal(await run('state.q'), '__vllm_filter__');
  assert.equal(await run('visible.length'), 0);
  await run("reset();setView('all')");
  assert.equal(await run('visible.length'), total);
  assert(await run("document.querySelector('[data-view=velocity]')!==null"));
  // Check user-authored text stays inert when inserted into the detail panel.
  await run(
    "prs[0].title='<img src=x onerror=alert(1)>';prs[0].trigger.body='<script>window.injected=true</script>';showDetails(prs[0].number)",
  );
  assert.equal(await run("document.querySelector('#detail-content img')!==null"), false);
  assert.equal(await run('window.injected===true'), false);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const report = {
    passed: true,
    total,
    checks: [
      'render',
      'FlashInfer workspace and My PRs',
      'workspace filter and URL isolation',
      'FlashInfer commenter view and previews',
      'workspace mobile layout',
      'priority navigation',
      'Approved filtering and URL state',
      'approval decision semantics',
      'commit-only follow-up filter',
      'follow-up filter URL persistence and scope',
      'my PRs',
      'search / empty state',
      'detail evidence',
      'commit preview message and author',
      'inline reply and code context',
      'compact velocity header',
      'rules dialog',
      'draft filter',
      'involvement filter',
      'author filter',
      'sort',
      'desktop layout',
      'mobile layout',
      'HTML injection safety',
      'review velocity navigation',
      'daily/weekly/monthly grouping',
      'unique PR vs submission counts',
      'zero buckets',
      'chart drilldown',
      'velocity mobile layout',
      'no JS exceptions',
    ],
  };
  await writeFile(root + '/.tmp/browser-validation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  ws?.close();
  chrome.kill('SIGTERM');
}
