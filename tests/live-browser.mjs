import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const backend = spawn(process.env.PYTHON || 'python3', [root + '/tests/fake_live_server.py'], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
const port = await new Promise((res, rej) => {
  let text = '';
  backend.stdout.on('data', (b) => {
    text += b;
    if (text.includes('\n')) res(JSON.parse(text.split('\n')[0]).port);
  });
  backend.on('exit', (code) => rej(new Error('Fake backend exited ' + code)));
});
const base = `http://127.0.0.1:${port}`;
const probe = await fetch(base);
assert.equal(probe.status, 200);
await probe.text();
const profile = root + '/.tmp/live-chrome-' + Date.now();
await mkdir(profile, { recursive: true });
const chrome = spawn(
  process.env.CHROME_BIN || '/usr/bin/google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--user-data-dir=' + profile,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const clients = [];
const errors = [];
try {
  let devPort;
  for (let i = 0; i < 100; i++) {
    try {
      devPort = (await readFile(profile + '/DevToolsActivePort', 'utf8')).split('\n')[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert(devPort);
  async function connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(m.error) : p.resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const run = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const client = { send, run, ws };
    clients.push(client);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    return client;
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();

  const firstTarget = await (
    await fetch(`http://127.0.0.1:${devPort}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const a = await connect(firstTarget);
  const second = await (
    await fetch(`http://127.0.0.1:${devPort}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const b = await connect(second);
  for (const c of [a, b]) {
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const navigation = await c.send('Page.navigate', { url: base + '/' });
    if (navigation.errorText) {
      await delay(300);
      await c.send('Page.navigate', { url: base + '/' });
    }
  }
  async function until(c, expression) {
    for (let i = 0; i < 100; i++) {
      try {
        if (await c.run(expression)) return;
      } catch {}
      await delay(100);
    }
    throw Error(
      'Timed out: ' +
        expression +
        '; errors=' +
        JSON.stringify(errors) +
        '; page=' +
        (await c.run(
          'JSON.stringify({url:location.href,ready:document.readyState,html:document.documentElement.outerHTML.slice(0,300)})',
        )),
    );
  }
  await until(a, 'typeof liveStatus!=="undefined"&&liveStatus!==null');
  await until(b, 'typeof liveStatus!=="undefined"&&liveStatus!==null');
  const status = async () => await (await fetch(base + '/api/status')).json();
  async function leaveAndReturn() {
    await b.send('Page.bringToFront');
    await delay(350);
    await a.send('Page.bringToFront');
    await delay(1100);
  }
  async function clickWithoutNavigation(selector, type = 'click', button = 0, ctrlKey = false) {
    await a.run(
      `(()=>{const link=document.querySelector(${JSON.stringify(selector)});link.addEventListener(${JSON.stringify(type)},event=>event.preventDefault(),{once:true});link.dispatchEvent(new MouseEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,button:${button},ctrlKey:${ctrlKey}}));})()`,
    );
  }

  assert.equal((await status()).sessionApiCalls, 0, 'Status polling must not call GitHub');
  assert(await a.run("document.querySelector('#api-usage').classList.contains('low')"));
  await a.send('Page.bringToFront');
  await a.run("document.querySelector('#workspace [data-view=ready]').click()");
  assert(
    await a.run(
      "visible.length===1&&visible.every(p=>p.ready)&&document.querySelector('#view-title').textContent==='Ready to merge'",
    ),
  );
  assert.equal(await a.run("document.querySelector('#rows .badge').textContent"), 'Ready to merge');
  for (const width of [1440, 390]) {
    await a.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
    assert.equal(await a.run('document.documentElement.scrollWidth>innerWidth'), false);
    const screenshot = await a.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(root + '/.tmp/ready-' + width + '.png', Buffer.from(screenshot.data, 'base64'));
  }
  await a.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await a.run('readHash();render()');
  assert.equal(await a.run('state.view'), 'ready');
  await a.run("setView('all');showDetails(prs[0].number)");

  await until(a, 'liveStatus.sessionApiCalls===1&&!liveStatus.active');
  assert(
    await a.run(
      "document.querySelector('.merge-readiness.is-ready').textContent.includes('test-maintainer')",
    ),
  );
  const dismissalNumber = await a.run('prs[0].number');
  const automaticQueue = await a.run('prs[0].queue');
  const beforeDismiss = (await status()).sessionApiCalls;
  await a.run(
    `setView(${JSON.stringify(automaticQueue)});document.querySelector('[data-dismiss-pr]').click()`,
  );
  await until(a, '!!prs[0].dismissal');
  assert.equal(await a.run('prs[0].queue'), 'watching');
  assert.equal(
    await a.run('prs[0].ready'),
    true,
    'Discussion dismissal must not remove merge readiness',
  );
  assert.equal(await a.run('visible.some(p=>p.number===prs[0].number)'), false);
  assert(
    await a.run(
      "document.querySelector('#detail').open&&document.querySelector('[data-dismiss-pr]').textContent==='Undo dismissal'",
    ),
  );
  await b.run('pollLiveStatus()');
  await until(b, '!!prs[0].dismissal');
  await b.send('Page.navigate', { url: base + '/' });
  await until(b, 'typeof liveStatus!=="undefined"&&liveStatus!==null&&!!prs[0].dismissal');
  assert.equal(
    (await status()).sessionApiCalls,
    beforeDismiss,
    'Dismissal and page reload are local',
  );
  await a.run("document.querySelector('[data-dismiss-pr]').click()");
  await until(a, '!prs[0].dismissal');
  assert.equal(await a.run('prs[0].queue'), automaticQueue);
  await a.run("setView('all')");

  const idleCalls = (await status()).sessionApiCalls;
  await leaveAndReturn();
  assert.equal(
    (await status()).sessionApiCalls,
    idleCalls,
    'Switching tabs with a preview open must not refresh',
  );
  await a.run("window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'))");
  await delay(1100);
  assert.equal(
    (await status()).sessionApiCalls,
    idleCalls,
    'Desktop workspace focus changes must not refresh',
  );
  await clickWithoutNavigation('#detail-content .evidence-link');
  await leaveAndReturn();
  assert.equal(
    (await status()).sessionApiCalls,
    idleCalls,
    'Discussion links must not arm an Open PR return refresh',
  );

  await a.run("document.querySelector('#detail').close()");
  await a.run("document.querySelector('#refresh-all').click()");
  await until(a, 'liveStatus?.active?.kind==="global"');
  await b.run('pollLiveStatus()');
  await until(b, 'liveStatus?.active?.kind==="global"');
  assert.equal(await b.run("document.querySelector('#refresh-progress').hidden"), false);
  await b.run("document.querySelector('#api-usage').click()");
  await until(b, 'liveStatus.frozen');
  await delay(600);
  const frozenCalls = (await status()).sessionApiCalls;
  await delay(650);
  assert.equal((await status()).sessionApiCalls, frozenCalls);
  await a.run('pollLiveStatus()');
  assert(await a.run("document.querySelector('#api-usage').classList.contains('frozen')"));
  await a.run('showDetails(prs[0].number)');
  await delay(700);
  assert.equal((await status()).sessionApiCalls, frozenCalls);
  await a.run("document.querySelector('[data-dismiss-pr]').click()");
  await until(a, '!!prs[0].dismissal');
  assert.equal(
    (await status()).sessionApiCalls,
    frozenCalls,
    'Dismissal works while API refreshes are frozen',
  );
  await a.run("document.querySelector('[data-dismiss-pr]').click()");
  await until(a, '!prs[0].dismissal');

  const paused = await a.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/live-paused.png', Buffer.from(paused.data, 'base64'));
  await a.run(
    "document.querySelector('#detail-api-usage').click();document.querySelector('#detail').close()",
  );
  await until(a, 'liveStatus&&!liveStatus.frozen&&!liveStatus.active&&!liveStatus.queued.length');
  await a.send('Page.bringToFront');
  const first = await a.run('prs[0].number');
  const before = (await status()).sessionApiCalls;
  await a.run(`document.querySelector('[data-refresh-pr="${first}"]').click()`);
  await until(
    a,
    `liveStatus.sessionApiCalls>${before}&&!liveStatus.active&&!liveStatus.queued.length`,
  );
  await until(a, "prs[0].reason==='Fresh data from the local test backend'");
  assert.equal((await status()).sessionApiCalls, before + 1);
  await b.run('pollLiveStatus()');
  assert.equal(await b.run('prs[0].reason'), 'Fresh data from the local test backend');
  // Exercise the actual link listener and browser focus/visibility events.
  const beforeReturn = (await status()).sessionApiCalls;
  await a.run(`showDetails(${first},{refresh:false})`);
  await clickWithoutNavigation('#detail-content .github-button');
  await leaveAndReturn();
  await until(a, `liveStatus.sessionApiCalls>${beforeReturn}&&!liveStatus.active`);
  assert.equal(
    (await status()).sessionApiCalls,
    beforeReturn + 1,
    'Open PR click must refresh once on return',
  );
  await a.run(`showDetails(${first})`);
  await delay(700);
  assert.equal(
    (await status()).sessionApiCalls,
    beforeReturn + 1,
    'Opening after returning should reuse the fresh result',
  );
  await leaveAndReturn();
  assert.equal(
    (await status()).sessionApiCalls,
    beforeReturn + 1,
    'A consumed link click must not refresh on later tab switches',
  );
  await a.run("document.querySelector('#detail').close()");
  for (const [type, button, ctrlKey] of [
    ['auxclick', 1, false],
    ['click', 0, true],
  ]) {
    const beforeLink = (await status()).sessionApiCalls;
    await clickWithoutNavigation('#rows tr:first-child a.external', type, button, ctrlKey);
    await leaveAndReturn();
    await until(a, `liveStatus.sessionApiCalls>${beforeLink}&&!liveStatus.active`);
    assert.equal(
      (await status()).sessionApiCalls,
      beforeLink + 1,
      'Row middle/Ctrl-click must refresh once on return',
    );
  }

  await a.run(
    `showDetails(${first},{refresh:false});document.querySelector('[data-dismiss-pr]').click()`,
  );
  await until(a, '!!prs[0].dismissal');
  await a.run(`refreshPR(workspaceKey,${first},'manual')`);
  await until(a, '!liveStatus.active&&!liveStatus.queued.length');
  assert(await a.run('!!prs[0].dismissal'), 'Unchanged refresh preserves dismissal');
  await a.run(`localAPI('/test/new-activity',{workspace:workspaceKey,number:${first}})`);
  await a.run(`refreshPR(workspaceKey,${first},'manual')`);
  await until(a, '!prs[0].dismissal&&!liveStatus.active');
  assert.equal(await a.run('prs[0].queue'), 'direct');
  assert.equal(
    await a.run("document.querySelector('[data-dismiss-pr]').textContent"),
    'Dismiss current activity',
  );
  await b.run('pollLiveStatus()');
  await until(b, '!prs[0].dismissal');
  await a.run("setView('ready')");
  assert.equal(await a.run('visible.length'), 1);
  await a.run(`localAPI('/test/failed-checks',{workspace:workspaceKey,number:${first}})`);
  await a.run(`refreshPR(workspaceKey,${first},'manual')`);
  await until(a, '!prs[0].ready&&!liveStatus.active');
  assert.equal(await a.run('visible.length'), 0);
  assert(
    await a.run(
      "document.querySelector('.merge-readiness').textContent.includes('Checks are failing')",
    ),
  );
  await b.run('pollLiveStatus()');
  await until(b, '!prs[0].ready');

  await a.run("document.querySelector('#detail').close();setView('approved')");
  const approvedNumber = await a.run(
    "prs.find(p=>p.events.some(e=>e.id==='fixture-my-approval')).number",
  );
  assert(
    await a.run(`visible.some(p=>p.number===${approvedNumber}&&!p.ready)`),
    'Approved includes PRs that are not ready to merge',
  );
  const beforeApprovalView = (await status()).sessionApiCalls;
  await a.run(
    `showDetails(${approvedNumber},{refresh:false});document.querySelector('[data-dismiss-pr]').click()`,
  );
  await until(a, `!!prs.find(p=>p.number===${approvedNumber}).dismissal`);
  assert(
    await a.run(`visible.some(p=>p.number===${approvedNumber})`),
    'Local discussion dismissal must not hide an approved PR',
  );
  await a.run("document.querySelector('[data-dismiss-pr]').click()");
  await until(a, `!prs.find(p=>p.number===${approvedNumber}).dismissal`);
  assert.equal(
    (await status()).sessionApiCalls,
    beforeApprovalView,
    'Approved filtering and local dismissals add no GitHub calls',
  );
  await a.run(
    `localAPI('/test/revoke-approval',{workspace:workspaceKey,number:${approvedNumber}})`,
  );
  await a.run(`refreshPR(workspaceKey,${approvedNumber},'manual')`);
  await until(a, `!approvalIndex().has(${approvedNumber})&&!liveStatus.active`);
  assert.equal(await a.run(`visible.some(p=>p.number===${approvedNumber})`), false);
  await b.run('pollLiveStatus()');
  await until(b, `!approvalIndex().has(${approvedNumber})`);
  await a.run("document.querySelector('#detail').close();switchWorkspace('flashinfer')");
  const beforeOpen = (await status()).sessionApiCalls;
  // Global refresh made these PRs fresh, so use a manual request to check preview patching, then open remains free.
  await a.run("showDetails(prs[0].number);refreshPR(workspaceKey,prs[0].number,'manual')");
  await until(a, 'liveStatus.sessionApiCalls>' + beforeOpen + '&&!liveStatus.active');
  await until(
    a,
    "document.querySelector('#detail-content').textContent.includes('Fresh data from the local test backend')",
  );
  await a.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(await a.run('document.documentElement.scrollWidth>innerWidth'), false);
  await a.run("document.querySelector('#detail').close()");
  const shot = await a.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(root + '/.tmp/live-mobile.png', Buffer.from(shot.data, 'base64'));
  // Pinning and fuzzy discovery use only the shared local index.
  await a.run("switchWorkspace('vllm');reset();setView('all')");
  await b.run("switchWorkspace('vllm');reset();setView('all')");
  await a.run("localAPI('/api/freeze',{frozen:true})");
  await a.run('pollLiveStatus()');
  await until(a, 'liveStatus.frozen&&!liveStatus.active');
  const beforePins = (await status()).sessionApiCalls;
  assert.equal(
    await a.run("document.querySelector('[data-view=pinned]').nextElementSibling.dataset.view"),
    'approved',
  );
  const pinnedNumber = await a.run('prs[0].number');
  await a.run(`document.querySelector('#rows [data-pin-pr="${pinnedNumber}"]').click()`);
  await until(a, `prs.find(p=>p.number===${pinnedNumber}).pinned`);
  assert.equal(await a.run("document.querySelector('#detail').open"), false);
  await b.run('pollLiveStatus()');
  await until(b, `prs.find(p=>p.number===${pinnedNumber}).pinned`);
  await a.run("setView('pinned');readHash();render()");
  assert.equal(await a.run('state.view'), 'pinned');
  assert.deepEqual(await a.run('visible.map(p=>p.number)'), [pinnedNumber]);

  assert.equal(await a.run("findPinMatches('cahce sched')[0].pr.number"), 2);
  assert.equal(await a.run("findPinMatches('#2')[0].pr.number"), 2);
  assert(await a.run("findPinMatches('@author').some(({pr})=>pr.number===2)"));
  assert.equal(await a.run("findPinMatches('jrdn exmpl')[0].pr.number"), 2);
  assert.equal(await a.run("findPinMatches('JORDAN')[0].pr.number"), 2);
  await a.run(
    "state.q='__hide_pinned_rows__';render();document.querySelector('#pin-search').focus();document.querySelector('#pin-search').value='jrdn exmpl';document.querySelector('#pin-search').dispatchEvent(new Event('input'))",
  );
  assert.equal(await a.run('visible.length'), 0);
  assert.equal(await a.run("document.querySelectorAll('#pin-matches li').length"), 1);
  assert(
    await a.run("document.querySelector('#pin-matches').textContent.includes('Jórdán Example')"),
  );
  await a.run(
    "document.querySelector('#pin-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
  );
  await until(a, 'prs.find(p=>p.number===2).pinned&&!pinPending.size');
  assert.equal(await a.run('document.activeElement.id'), 'pin-search');
  await a.run("reset();setView('pinned')");
  assert.equal(await a.run('visible.length'), 2);
  await b.run('pollLiveStatus()');
  await until(b, 'prs.find(p=>p.number===2).pinned');
  for (const width of [1440, 390]) {
    await a.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 950,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
    await a.run(
      "document.querySelector('#pin-search').focus();document.querySelector('#pin-search').value='exmple';document.querySelector('#pin-search').dispatchEvent(new Event('input'))",
    );
    assert.equal(await a.run('document.documentElement.scrollWidth>innerWidth'), false);
    const pinnedShot = await a.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      root + '/.tmp/pinned-' + width + '.png',
      Buffer.from(pinnedShot.data, 'base64'),
    );
  }
  await a.run(
    "document.querySelector('#pin-search').value='unmatchablezzzz';document.querySelector('#pin-search').dispatchEvent(new Event('input'))",
  );
  assert.equal(await a.run("document.querySelectorAll('#pin-matches li').length"), 0);
  assert(
    await a.run(
      "document.querySelector('#pin-search-status').textContent.includes('indexed pool')",
    ),
  );
  assert(
    await a.run(
      "(async()=>{try{await localAPI('/api/pin',{workspace:'vllm',number:999999,pinned:true});return false;}catch(e){return e.message.includes('not in this workspace');}})()",
    ),
  );
  await a.run(
    "document.querySelector('#pin-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));showDetails(2,{refresh:false})",
  );
  await a.run("document.querySelector('#detail [data-dismiss-pr]').click()");
  await until(a, 'prs.find(p=>p.number===2).dismissal');
  assert(await a.run('prs.find(p=>p.number===2).pinned&&visible.some(p=>p.number===2)'));
  await a.run("document.querySelector('#detail [data-dismiss-pr]').click()");
  await until(a, '!prs.find(p=>p.number===2).dismissal');
  await a.run("document.querySelector('#detail [data-pin-pr]').click()");
  await until(a, '!prs.find(p=>p.number===2).pinned&&!pinPending.size');
  assert(await a.run("document.querySelector('#detail').open"));
  assert.equal(
    await a.run("document.querySelector('#detail [data-pin-pr]').getAttribute('aria-pressed')"),
    'false',
  );
  await a.run("document.querySelector('#detail [data-pin-pr]').click()");
  await until(a, 'prs.find(p=>p.number===2).pinned&&!pinPending.size');
  await a.run(
    "document.querySelector('#detail').close();switchWorkspace('flashinfer');setView('pinned')",
  );
  assert.equal(await a.run('visible.length'), 0);
  assert.equal(await a.run("document.querySelector('#pin-search').value"), '');
  await a.run("setView('all');document.querySelector('#rows [data-pin-pr]').click()");
  await until(a, 'prs.some(p=>p.pinned)&&!pinPending.size');
  await a.run("setView('pinned')");
  assert.equal(await a.run('visible.length'), 1);
  await a.run("switchWorkspace('vllm');setView('pinned')");
  assert.equal(await a.run('visible.length'), 2);
  assert.equal(
    (await status()).sessionApiCalls,
    beforePins,
    'Search, pin, unpin, and dismissal make no GitHub calls',
  );
  await a.run("localAPI('/test/restart',{})");
  await a.send('Page.reload');
  await until(
    a,
    "typeof liveStatus!=='undefined'&&liveStatus?.frozen&&state.view==='pinned'&&visible.length===2",
  );
  assert.equal((await status()).sessionApiCalls, 0, 'Restoring pins makes no GitHub calls');
  await b.run('pollLiveStatus()');
  await until(b, 'prs.filter(p=>p.pinned).length===2');
  await a.run("localAPI('/api/freeze',{frozen:false})");
  await a.run(`localAPI('/test/new-activity',{workspace:'vllm',number:${pinnedNumber}})`);
  await a.run(`refreshPR('vllm',${pinnedNumber},'manual')`);
  await until(
    a,
    `!liveStatus.active&&prs.find(p=>p.number===${pinnedNumber}).trigger.id.startsWith('test-mention-')`,
  );
  assert(
    await a.run(`prs.find(p=>p.number===${pinnedNumber}).pinned`),
    'New activity preserves pins',
  );
  await a.run(`document.querySelector('#rows [data-pin-pr="${pinnedNumber}"]').click()`);
  await until(a, `!prs.find(p=>p.number===${pinnedNumber}).pinned&&!pinPending.size`);
  assert.equal(await a.run('visible.length'), 1);
  await b.run('pollLiveStatus()');
  await until(b, `!prs.find(p=>p.number===${pinnedNumber}).pinned`);
  await a.run("localAPI('/test/remove-pr',{workspace:'vllm',number:2})");
  await a.run('pollLiveStatus()');
  await until(a, '!prs.some(p=>p.number===2)&&visible.length===0');
  assert.equal(
    await a.run("findPinMatches('#2').length"),
    0,
    'Pins cannot keep removed PRs outside the indexed pool',
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const report = {
    passed: true,
    realGitHubCalls: 0,
    checks: [
      'two browser sessions share global progress',
      'shared freeze pauses further API calls',
      'freeze control works inside preview',
      'preview clicks respect freeze',
      'API warning display',
      'manual item refresh',
      'refresh on preview open',
      'updated data reaches both sessions',
      'tab and desktop workspace switches do not refresh',
      'discussion links do not arm return refresh',
      'Open PR return refresh happens only once',
      'row middle-click and Ctrl-click return refresh',
      'open after return does not duplicate API usage',
      'preview updates without closing',
      'dismissal removes action and updates both sessions',
      'dismissal survives reload without API calls',
      'Undo restores automatic queue',
      'dismissal works while frozen',
      'unchanged refresh preserves dismissal',
      'new activity automatically restores priority',
      'Ready view filters and URL state',
      'Ready preview shows approval and checks',
      'discussion dismissal preserves Ready membership',
      'failing checks remove PR from Ready across sessions',
      'Approved includes blocked PRs',
      'discussion dismissal preserves Approved membership',
      'dismissed GitHub approval removes PR across sessions',
      'mobile layout',
      'Pinned tab order and URL state',
      'row and sidepanel pin controls',
      'shared persistent pins across sessions and restart',
      'pins work while frozen without API calls',
      'pins survive dismissal and new activity',
      'fuzzy title, number, login, and display-name search',
      'keyboard pinning and search independent of view filters',
      'workspace isolation and rejection outside the indexed pool',
      'pinned desktop/mobile layout',
      'no JavaScript exceptions',
    ],
  };
  await writeFile(root + '/.tmp/live-browser-validation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  for (const c of clients) c.ws.close();
  chrome.kill('SIGTERM');
  backend.kill('SIGTERM');
}
