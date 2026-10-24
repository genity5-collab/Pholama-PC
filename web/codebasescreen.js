// The Pholama Codebase screen (PC only): a terminal-style coding agent you watch work.
// Task box, live feed, Allow / Deny cards, folder access, the usage bar, Stop.
// Everything the AI wrote is untrusted text: it only ever reaches the page through esc() / textContent.
// The login and GitHub tokens are asked for at the moment of Start and sent as headers once; they are never kept on this page.

const esc = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// What a person reads for each event the server streams. No model or provider name is ever shown.
export const MARKS = { ok: '\u2705', x: '\u274C' };
export function describe(e) {
  if (!e || typeof e !== 'object') return null;
  const tool = clip(e.tool, 40);
  switch (e.kind) {
    case 'tool': {
      if (tool === 'note_') return { tone: 'note', tag: 'NOTE', text: clip(String(e.args || '').replace(/^\{.*?"(?:text|content|note|summary|message)":"/, '').replace(/"\}*$/, ''), 400) || 'Note' };
      const bad = /^(REFUSED|ERROR):/.test(String(e.result || ''));
      if (tool === 'screenshot_') return { tone: bad ? 'bad' : 'ok', mark: bad ? 'x' : 'ok', tag: 'SCREEN', text: 'Screenshot' + (e.cost ? '' : ''), result: clip(String(e.result || '').split('\nOPEN WINDOWS')[0], 500), cost: e.cost || 0, shot: /^[a-f0-9]{16}$/.test(String(e.shot || '')) ? e.shot : '' };
      return { tone: bad ? 'bad' : 'ok', mark: bad ? 'x' : 'ok', tag: 'TOOL', text: tool + (e.args ? ' ' + clip(e.args, 220) : ''), result: clip(e.result, 500), cost: e.cost || 0 };
    }
    case 'ask': return { tone: 'ask', tag: 'ASK', text: tool + ' is waiting for you', callId: e.callId, strict: e.level === 'strict', args: clip(e.args, 400), tool };
    case 'answered': return { tone: 'info', tag: 'YOU', text: e.allowed === false ? 'You said No' : (e.auto ? 'Allowed automatically (Always allow is on)' : 'You said Yes') };
    case 'expired': return { tone: 'warn', tag: 'TIME', text: 'No answer in time, so it was not done' };
    case 'refused': return { tone: 'bad', mark: 'x', tag: 'BLOCKED', text: clip(e.say || e.reason, 240) || 'That was blocked' };
    case 'retry': return { tone: 'mute', tag: 'AGAIN', text: clip(e.say, 160) || 'Trying again' };
    case 'stopped': return { tone: 'warn', tag: 'STOP', text: clip(e.say, 240) || 'Stopped' };
    case 'done': return { tone: 'good', mark: 'ok', tag: 'DONE', text: clip(e.say || e.summary, 600) || 'Finished' };
    default: return null;   // end, hello and anything unknown stay out of the feed
  }
}

// The one place that turns a described row into HTML. Every dynamic piece is escaped.
export function rowHtml(d) {
  if (!d) return '';
  const card = d.tone === 'ask'
    ? '<div class="cbs-ask' + (d.strict ? ' strict' : '') + '" data-call="' + esc(d.callId) + '"><b>' + esc(d.tool) + '</b> wants to run' + (d.strict ? ' <em>(asked every time)</em>' : '') + (d.args ? ':<pre>' + esc(d.args) + '</pre>' : '') +
      '<div class="cbs-btns"><button class="cbs-allow" data-allow="1">Allow</button>' + (d.strict ? '' : '<button class="cbs-always" data-always="' + esc(d.tool) + '" title="Allow this kind of request from now on. You can turn it off in the list on the right.">Always allow ' + esc(d.tool) + '</button>') + '<button class="cbs-deny" data-allow="0">Deny</button></div></div>'
    : '';
  return '<li class="cbs-row ' + esc(d.tone) + '">' + (MARKS[d.mark] ? '<span class="cbs-mark">' + MARKS[d.mark] + '</span>' : '') + '<span class="cbs-tag">' + esc(d.tag) + '</span><span class="cbs-txt">' + esc(d.text) + '</span>' +
    (d.cost ? '<span class="cbs-cost">' + esc(d.cost) + ' credits</span>' : '') + (d.result ? '<div class="cbs-res">' + esc(d.result) + '</div>' : '') +
    (d.shot ? '<a class="cbs-shot" href="/api/codebase/shot/' + esc(d.shot) + '" target="_blank" rel="noopener"><img alt="Screenshot the AI took" loading="lazy" src="/api/codebase/shot/' + esc(d.shot) + '"></a>' : '') + card + '</li>';
}

// A short, calm line about how the run ended. Never a model or provider name.
export function endLine(r) {
  if (!r) return '';
  if (r.ok) return 'Finished in ' + (r.steps || 0) + ' step' + (r.steps === 1 ? '' : 's') + '.';
  const why = { stuck: 'It got stuck, so it was stopped.', user: 'You stopped it.', stop: 'You stopped it.', credits: 'Out of credits for now.', budget: 'Out of credits for now.', time: 'It ran out of time.', paused: 'Resting for a while.', login: 'Please sign in to Pholama, then press Start.', model: 'The AI did not answer after a few tries. Press Start again in a moment.', error: 'Something went wrong. Press Start to try again.' };
  return why[r.stopped] || 'It stopped.';
}

export function mountCodebase(root, deps = {}) {
  const { fetchFn = (...a) => fetch(...a), getToken = () => '', getFreshToken = null, keepAliveMs = 120000, getGithubToken = () => '', EventSourceCtor = (typeof EventSource !== 'undefined' ? EventSource : null) } = deps;
  const $ = s => root.querySelector(s);
  root.innerHTML =
    '<div class="cbs">' +
      '<div class="cbs-top"><h2>Codebase</h2></div>' +   // the usage bar is the page-level #cbUsage slot above the views
      '<div class="cbs-grid">' +
        '<section class="cbs-main">' +
          '<div class="cbs-task"><textarea id="cbsTask" rows="3" maxlength="4000" placeholder="Tell it what to build or fix. It works step by step and asks before changing anything."></textarea>' +
          '<div class="cbs-bar"><select id="cbsKind" aria-label="How hard is the job"><option value="simple">Simple edit</option><option value="hard">Debugging or a big change</option></select>' +
          '<select id="cbsMinutes" aria-label="Longest it may work"><option value="15">Up to 15 min</option><option value="45" selected>Up to 45 min</option><option value="90">Up to 90 min</option><option value="240">Up to 4 hours</option></select>' +
          '<button id="cbsStart" class="cbs-go">Start</button><button id="cbsStop" class="cbs-stop" disabled>Stop</button><button id="cbsClear" title="Empty the list below (it does not stop anything)">Clear</button><button id="cbsClear" title="Empty the list below (it does not stop anything)">Clear</button><span id="cbsMsg" class="cbs-msg" role="status"></span></div></div>' +
          '<ul id="cbsFeed" class="cbs-feed" aria-live="polite"><li class="cbs-empty">Nothing yet. Give it a folder, then a task.</li></ul>' +
        '</section>' +
        '<aside class="cbs-side"><h3>Folders it may use</h3><ul id="cbsGrants" class="cbs-grants"></ul>' +
          '<div class="cbs-add"><input id="cbsDir" type="text" placeholder="C:\\Users\\you\\my-project" aria-label="Folder path"><select id="cbsMode" aria-label="Access"><option value="read">Read only</option><option value="write">Read and change</option></select><button id="cbsGrant">Allow</button></div>' +
          '<p class="cbs-hint">It can only touch folders listed here. Deleting and installing are always asked about, every time.</p>' +
          '<h3 class="cbs-h3b">Always allowed</h3><ul id="cbsAlways" class="cbs-grants"></ul><button id="cbsAlwaysOff" class="cbs-alloff">Turn off all</button>' +
          '<h3 class="cbs-h3b">Memory</h3><ul id="cbsMem" class="cbs-grants"></ul>' +
          '<div class="cbs-add"><input id="cbsMemText" type="text" maxlength="400" placeholder="Something it should always remember" aria-label="Add to memory"><button id="cbsMemAdd">Remember</button></div>' +
          '<p class="cbs-hint">The agent reads this at the start of every run, and can add or remove things itself.</p>' +
          '<h3 class="cbs-h3b">Earlier sessions</h3><ul id="cbsSess" class="cbs-grants"></ul><button id="cbsSessClear" class="cbs-alloff">Delete all sessions</button>' +
          '<p class="cbs-hint">Kinds of request you pressed "Always allow" for. Turn any of them off here. Dangerous ones (terminal, PowerShell, delete) are never in this list.</p></aside>' +
      '</div></div>';

  const paintUsage = () => { try { const u = typeof window !== 'undefined' && window.PholamaCodebaseUsage; if (u) u.paint(); } catch {} };   // the usage bar is optional
  const feed = $('#cbsFeed'), msg = $('#cbsMsg'), startB = $('#cbsStart'), stopB = $('#cbsStop');
  let es = null, runId = '', rows = 0;
  const say = (t, bad) => { msg.textContent = t || ''; msg.className = 'cbs-msg' + (bad ? ' bad' : ''); };
  const json = async (url, opts) => { const r = await fetchFn(url, opts); let j = {}; try { j = await r.json(); } catch {} return { ok: r.ok, status: r.status, j }; };
  // While a job runs, send the newest login to the server every couple of minutes, so a long job never carries a dead (expired) one.
  let keepAlive = null;
  const freshToken = async () => { try { return (getFreshToken ? await getFreshToken() : '') || getToken() || ''; } catch { return getToken() || ''; } };
  const busy = on => {
    startB.disabled = on; stopB.disabled = !on; $('#cbsTask').disabled = on;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (on) { keepAlive = setInterval(async () => { const t = await freshToken(); if (t) json('/api/codebase/token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pholama-token': t }, body: '{}' }); }, keepAliveMs); if (keepAlive.unref) keepAlive.unref(); }
  };

  function push(e) {
    const d = describe(e); if (!d) return;
    if (feed.querySelector('.cbs-empty')) feed.innerHTML = '';
    // An answered / expired approval replaces its card, so old buttons never stay clickable.
    if (e.kind === 'answered' || e.kind === 'expired') for (const c of feed.querySelectorAll('.cbs-ask[data-call="' + String(e.callId || '').replace(/[^A-Za-z0-9_-]/g, '') + '"]')) c.remove();
    feed.insertAdjacentHTML('beforeend', rowHtml(d)); rows++;
    while (feed.children.length > 400) feed.removeChild(feed.firstChild);
    feed.lastElementChild && feed.lastElementChild.scrollIntoView && feed.lastElementChild.scrollIntoView({ block: 'end' });
    if (e.kind === 'ask' && e.callId) feed.lastElementChild.dataset.run = runId;
  }

  function watch() {
    if (!EventSourceCtor) return; try { es && es.close(); } catch {}
    es = new EventSourceCtor('/api/codebase/stream');
    es.onmessage = m => { let e; try { e = JSON.parse(m.data); } catch { return; } if (e && e.kind === 'end') { finish(); return; } push(e); };
    es.onerror = () => { /* the server closes the stream when a run ends; the state poll below notices */ };
  }
  async function finish() {
    try { es && es.close(); } catch {} es = null; busy(false);
    const s = await json('/api/codebase/state'); if (s.ok && s.j.result) say(endLine(s.j.result), !s.j.result.ok);
    paintUsage();
  }

  startB.onclick = async () => {
    const task = $('#cbsTask').value.trim(); if (!task) { say('Write what you want done first.', true); return; }
    const tk = await freshToken(); if (!tk) { say('Sign in first. The Codebase uses your Pholama account credits.', true); return; }
    say('Starting...'); busy(true); feed.innerHTML = ''; rows = 0;
    const gh = getGithubToken();
    const r = await json('/api/codebase/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pholama-token': tk, ...(gh ? { 'x-github-token': gh } : {}) }, body: JSON.stringify({ task, kind: $('#cbsKind').value, minutes: Number($('#cbsMinutes').value) || 45 }) });
    if (!r.ok) { busy(false); say(r.j.error || 'It could not start.', true); return; }
    runId = r.j.id || ''; say('Working...'); watch();
  };
  stopB.onclick = async () => { stopB.disabled = true; const r = await json('/api/codebase/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); say(r.ok ? 'Stopping...' : (r.j.error || 'Nothing to stop.'), !r.ok); if (!r.ok) stopB.disabled = false; };

  // Allow / Deny: one delegated handler, so cards added later work and cannot be double-clicked into two answers.
  feed.addEventListener('click', async ev => {
    const b = ev.target && ev.target.closest && ev.target.closest('button[data-allow], button[data-always]'); if (!b) return;
    const card = b.closest('.cbs-ask'); if (!card || card.dataset.sent === '1') return; card.dataset.sent = '1';
    for (const x of card.querySelectorAll('button')) x.disabled = true;
    if (b.dataset.always) {   // switch the kind on first, then say Yes to this one
      const a = await json('/api/codebase/always', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: b.dataset.always }) });
      if (a.ok) paintAlways(a.j.tools); else say(a.j.error || 'That cannot be always allowed.', true);
    }
    const r = await json('/api/codebase/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: runId, call: card.dataset.call, allow: b.dataset.allow === '1' || !!b.dataset.always }) });
    if (!r.ok) { card.dataset.sent = ''; for (const x of card.querySelectorAll('button')) x.disabled = false; say(r.j.error || 'That answer was not accepted.', true); }
  });

  async function paintGrants(list) {
    const g = list || (await json('/api/codebase/grants')).j.grants || [];
    const ul = $('#cbsGrants');
    ul.innerHTML = g.length ? g.map(x => '<li><span class="cbs-gd">' + esc(x.dir) + '</span><span class="cbs-gm">' + (x.mode === 'write' ? 'read + change' : 'read only') + '</span><button data-revoke="' + esc(x.dir) + '" aria-label="Remove access">Remove</button></li>').join('') : '<li class="cbs-empty">No folders yet.</li>';
  }
  $('#cbsClear').onclick = () => { feed.innerHTML = '<li class="cbs-empty">Cleared.</li>'; };
  async function paintAlways(list) {
    const t = list || (await json('/api/codebase/always')).j.tools || [];
    $('#cbsAlways').innerHTML = t.length ? t.map(x => '<li><span class="cbs-gd">' + esc(x) + '</span><span class="cbs-gm">always allowed</span><button data-off="' + esc(x) + '" aria-label="Turn off always allow for ' + esc(x) + '">Turn off</button></li>').join('') : '<li class="cbs-empty">None. Every request asks you first.</li>';
  }
  $('#cbsAlwaysOff').onclick = async () => { const r = await json('/api/codebase/always', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' }); paintAlways(r.j.tools); };
  $('#cbsAlways').addEventListener('click', async ev => {
    const b = ev.target && ev.target.closest && ev.target.closest('button[data-off]'); if (!b) return;
    const r = await json('/api/codebase/always', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: b.dataset.off }) });
    paintAlways(r.j.tools);
  });
  $('#cbsGrant').onclick = async () => {
    const dir = $('#cbsDir').value.trim(); if (!dir) { say('Type a folder path first.', true); return; }
    const r = await json('/api/codebase/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, mode: $('#cbsMode').value }) });
    if (!r.ok) { say(r.j.error || 'That folder cannot be used.', true); return; }
    say(''); $('#cbsDir').value = ''; paintGrants(r.j.grants);
  };
  $('#cbsGrants').addEventListener('click', async ev => {
    const b = ev.target && ev.target.closest && ev.target.closest('button[data-revoke]'); if (!b) return;
    const r = await json('/api/codebase/grants', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: b.dataset.revoke }) });
    paintGrants(r.j.grants);
  });

  // Memory and earlier sessions: look, add, delete.
  const H = { 'Content-Type': 'application/json' };
  async function paintMem(list) {
    const l = list || (await json('/api/codebase/memory')).j.memory || [];
    $('#cbsMem').innerHTML = l.length ? l.map(m => '<li><span class="cbs-gd">' + esc(m.text) + '</span><button data-forget="' + esc(m.id) + '" title="Delete this memory">Delete</button></li>').join('') : '<li class="cbs-gm">Nothing remembered yet.</li>';
  }
  async function paintSess(list) {
    const l = list || (await json('/api/codebase/sessions')).j.sessions || [];
    $('#cbsSess').innerHTML = l.length ? l.map(x => '<li><span class="cbs-gd">' + (x.ok ? '\u2705 ' : '\u274C ') + esc(x.name || x.task) + '</span><span class="cbs-gm">' + esc(String(x.work || 0)) + ' steps saved</span><button data-view="' + esc(x.id) + '" title="Show what it did">Open</button><button data-sess="' + esc(x.id) + '" title="Delete this session">Delete</button><pre class="cbs-wl" id="wl-' + esc(x.id) + '" hidden></pre></li>').join('') : '<li class="cbs-gm">No sessions yet.</li>';
  }
  $('#cbsMemAdd').onclick = async () => { const t = $('#cbsMemText').value.trim(); if (!t) return; const r = await json('/api/codebase/memory', { method: 'POST', headers: H, body: JSON.stringify({ text: t }) }); if (r.ok) { $('#cbsMemText').value = ''; paintMem(r.j.memory); } else say(r.j.error || 'Could not save that.', true); };
  $('#cbsMem').addEventListener('click', async ev => { const b = ev.target.closest && ev.target.closest('button[data-forget]'); if (!b) return; const r = await json('/api/codebase/memory', { method: 'DELETE', headers: H, body: JSON.stringify({ id: b.dataset.forget }) }); paintMem(r.ok ? r.j.memory : undefined); });
  $('#cbsSess').addEventListener('click', async ev => {
    const v = ev.target.closest && ev.target.closest('button[data-view]');
    if (v) { const box = $('#cbsSess').querySelector('pre[id="wl-' + v.dataset.view + '"]'); if (!box) return; if (!box.hidden) { box.hidden = true; return; } const r = await json('/api/codebase/sessions/' + encodeURIComponent(v.dataset.view)); box.textContent = r.ok ? ((r.j.summary ? r.j.summary + '\n\n' : '') + ((r.j.work || []).concat(r.j.notes || [])).join('\n') || 'Nothing was saved for this session.') : 'Could not open it.'; box.hidden = false; return; }
    const b = ev.target.closest && ev.target.closest('button[data-sess]'); if (!b) return; const r = await json('/api/codebase/sessions', { method: 'DELETE', headers: H, body: JSON.stringify({ id: b.dataset.sess }) }); paintSess(r.ok ? r.j.sessions : undefined); });
  $('#cbsSessClear').onclick = async () => { const r = await json('/api/codebase/sessions', { method: 'DELETE', headers: H, body: JSON.stringify({ all: true }) }); paintSess(r.ok ? r.j.sessions : undefined); };

  // Opening the screen: show the folders and usage, and pick up a run that is already going (the page was reloaded).
  async function open() {
    paintGrants();
    paintAlways();
    paintMem();
    paintSess();
    paintUsage();
    const s = await json('/api/codebase/state');
    if (s.ok && s.j.running) { runId = s.j.id || ''; busy(true); say('Working...'); feed.innerHTML = ''; watch(); }
  }
  return { open, push, paintGrants, destroy() { try { es && es.close(); } catch {} } };
}
