'use strict';
// Pholama Codebase: the /api/codebase/* routes. server.js hands every such request to handle() and does nothing else.
// Everything the outside can touch is decided here, and tested without the internet or a real PC (every effect is injected).
//  * only this PC may use it (server.js has already set req.who; this checks again)
//  * the cloud login comes from the page's x-pholama-token header and is kept only in memory for the run, never written to disk or logged
//  * the GitHub token is only what the person saved in this PC's settings, never an environment variable
//  * every answer the page sees is plain words: no model names, provider names or HTTP codes
const T = require('./codebase-tools');
const PLAN = require('./codebase-plan');
const SESSION = require('./codebase-session');
const MODEL = require('./codebase-model');
const MEM = require('./codebase-memory');

const MAX_BODY = 64 * 1024;          // a task, an answer or a grant is small; a bigger body is refused before it is read in full
const MAX_UPLOAD = 8 * 1024 * 1024;  // a screenshot or a picture the person attaches
const KINDS = new Set(['simple', 'hard', 'quick']);

function readBody(req, limit) {
  return new Promise(resolve => {
    let n = 0, chunks = [], dead = false;
    req.on('data', c => { if (dead) return; n += c.length; if (n > limit) { dead = true; chunks = []; resolve({ tooBig: true }); return; } chunks.push(c); });
    req.on('end', () => { if (dead) return; try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ data: {}, bad: true }); } });
    req.on('error', () => { if (!dead) { dead = true; resolve({ data: {}, bad: true }); } });
  });
}

// Builds the tools map the loop uses: every tool goes planner (grants, system folders, blocked commands) THEN the executor.
function buildTools(deps) {
  const { win, github, media, web, opened = new Set(), getGithubToken = () => '', readImage, fetchFn } = deps;
  const tools = {};
  for (const meta of T.list()) {
    const name = meta.name;
    tools[name] = async (args, ctx) => {
      const pl = PLAN.plan(name, args);
      if (!pl || pl.ok !== true) return 'REFUSED: ' + ((pl && pl.say) || 'not allowed');
      if (pl.kind === 'next_task') return 'Next task started.';
      if (pl.kind === 'chatbox') return INBOX.describe(inbox.take());
      if (pl.kind === 'remember') { const m = deps.memory || require('./codebase-memory'); const x = m.remember(pl.text); return x.ok ? x.text : 'ERROR: ' + x.text; }
      if (pl.kind === 'forget') { const m = deps.memory || require('./codebase-memory'); const x = m.forget(pl.id); return x.ok ? x.text : 'ERROR: ' + x.text; }
      if (pl.kind === 'note') { if (!deps.notepad) return 'Noted.'; const n = await deps.notepad.note(pl.text); return n.ok ? 'Noted.' + (n.live ? ' (shown in Notepad)' : '') : 'ERROR: ' + n.text; }
      let r;
      if (pl.kind === 'github_read' || pl.kind === 'github_write') r = await github.execute(pl, { token: getGithubToken(), fetchFn });
      else if (pl.kind === 'cloud_browse') r = deps.web ? await deps.web.execute(pl) : { ok: false, text: 'Web search is not available right now.' };   // fetched here, nothing opens on the PC
      else if (pl.kind === 'make') r = media && typeof media.execute === 'function' ? await media.execute(pl, { signal: ctx && ctx.signal }) : { ok: false, text: 'Making files is not available right now.' };   // a generator never reaches the Windows runner
      else r = await win.execute(pl, { opened, readImage });
      if (r && r.ok && r.shot && ctx && typeof ctx.shot === 'function') ctx.shot(r.shot);   // the loop attaches it to the log row
      return r && r.ok ? String(r.text == null ? 'Done.' : r.text) : 'ERROR: ' + String((r && r.text) || 'it did not work');
    };
  }
  return tools;
}

function create(deps) {
  const { grants, budget, now = Date.now, log = () => {}, fetchFn, cloudUrl } = deps;
  const state = { token: '', gh: '', kind: 'simple', credits: null };   // both tokens live in memory for ONE run only
  const INBOX = require('./codebase-inbox'), inbox = deps.inbox || INBOX.create(now);   // what the person types while the agent works
  const model = MODEL.makeModel({ getToken: () => state.token, getKind: () => state.kind, fetchFn, url: cloudUrl, log, onCredits: c => { state.credits = c; } });
  const notepad = deps.notepad === undefined ? (deps.win ? require('./codebase-notepad').create({
    write: async (f, c) => { const r = await deps.win.execute({ ok: true, kind: 'write', path: f, content: c, append: false }, {}); if (!r.ok) throw new Error('write'); },
    append: async (f, c) => { const r = await deps.win.execute({ ok: true, kind: 'write', path: f, content: c, append: true }, {}); if (!r.ok) throw new Error('append'); },
    open: async f => deps.win.execute({ ok: true, kind: 'notepad', path: f }, {}),
    close: async title => deps.win.execute({ ok: true, kind: 'close', title }, {}),   // no 'opened' set is passed, so this closes only the Pholama notes window by its exact title
  }) : null) : deps.notepad;
  const media = deps.media || require('./codebase-media').create({ getToken: () => state.token, fetchFn, url: deps.mediaUrl, log, onCredits: c => { state.credits = c; } });   // same login as the model, held in memory for one run only
  // Cloud search: the real chat helpers (safe address check, redirect re-check, DuckDuckGo), loaded only when first used so tests can inject a fake.
  const web = deps.web || require('./codebase-web').create({
    fetchText: (u, ms) => require('./agent').fetchText(u, ms),
    webSearch: o => require('./agent').webSearch(o, null),
    checkLink: u => require('./sources').checkLink(u),
  });
  const tools = deps.tools || buildTools({ ...deps, media, web, notepad, getGithubToken: deps.getGithubToken || (() => state.gh) });
  const session = SESSION.create({ inbox, model, tools, budget, now, sleep: deps.sleep, getContext: () => MEM.context(), onEnd: x => MEM.saveSession({ task: x.task, notes: x.notes, work: x.work, result: x.result, now }), onResult: r => { if (notepad && typeof notepad.mark === 'function') notepad.mark(r.good, r.what, r.detail).catch(() => {}); } });   // a tick or a cross for every step, written into the Notepad
  // The login lives only as long as the run: when the run ends (done, stopped, out of time or credits) it is wiped.
  const wipeWhenDone = () => { const t = setInterval(() => { const st = session.state(); if (st.done || !st.running) { state.token = ''; state.gh = ''; if (notepad) notepad.finish().catch(() => {}); clearInterval(t); } }, 250); if (t.unref) t.unref(); };

  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...(res.cors || {}) }); res.end(JSON.stringify(obj)); };
  const plain = e => (e && e.plain ? e.message : 'Something went wrong. Try again.');

  async function handle(req, res, p, u) {
    if (!p.startsWith('/api/codebase')) return false;
    if (req.who !== 'local') { send(res, 403, { error: 'This can only be done on the PC itself.' }); return true; }
    const method = req.method;
    try {
      // ---- reads ----
      if (p === '/api/codebase/state' && method === 'GET') { send(res, 200, { ...session.state(), usage: budget.view(budget.load(now()), now()), grants: grants.list(), always: require('./codebase-always').list(), credits: state.credits }); return true; }
      if (p === '/api/codebase/stream' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...(res.cors || {}) });
        const out = e => { try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch {} };
        const stop = session.watch(out);
        if (!stop) { res.end('event: empty\ndata: {}\n\n'); return true; }
        res.write(': hello\n\n'); const beat = setInterval(() => { try { res.write(': \n\n'); } catch {} }, 20000); if (beat.unref) beat.unref();
        const done = () => { clearInterval(beat); stop(); }; req.on('close', done); res.on('error', done); return true;
      }
      if (p.startsWith('/api/codebase/shot/') && method === 'GET') {   // a screenshot the agent took, from memory; only a real id works
        const img = require('./codebase-shots').get(p.slice('/api/codebase/shot/'.length));
        if (!img) { send(res, 404, { ok: false }); return true; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': img.length }); res.end(img); return true;
      }
      if (p === '/api/codebase/memory' && method === 'GET') { send(res, 200, { memory: MEM.listMemory(), max: MEM.MAX_MEMORY }); return true; }
      if (p === '/api/codebase/sessions' && method === 'GET') { send(res, 200, { sessions: MEM.listSessions() }); return true; }
      if (p.startsWith('/api/codebase/sessions/') && method === 'GET') { const s = MEM.getSession(decodeURIComponent(p.slice(23))); send(res, s ? 200 : 404, s || { error: 'No such session.' }); return true; }
      if (p === '/api/codebase/usage' && method === 'GET') {   // the usage bar on the page: 5,000 / 7-hour rests / 15,000 per month
        let tz = 'UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch {}
        send(res, 200, { ...budget.view(budget.load(now()), now()), now: now(), tz }); return true;
      }
      if (p === '/api/codebase/always' && method === 'GET') { send(res, 200, { tools: require('./codebase-always').list() }); return true; }
      if (p === '/api/codebase/grants' && method === 'GET') { send(res, 200, { grants: grants.list() }); return true; }

      // ---- writes (every one reads a small, size-limited body) ----
      if (method !== 'POST' && method !== 'DELETE') { send(res, 405, { error: 'Not available.' }); return true; }
      const b = await readBody(req, MAX_BODY);
      if (b.tooBig) { send(res, 413, { error: 'That is too big.' }); return true; }
      const body = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};

      if (p === '/api/codebase/start' && method === 'POST') {
        const tk = String(req.headers['x-pholama-token'] || '').slice(0, 4000);
        if (!tk) { send(res, 401, { error: MODEL.PLAIN.login }); return true; }
        state.token = tk;                                  // memory only, for this run
        state.gh = String(req.headers['x-github-token'] || '').slice(0, 400);   // the person's own GitHub token, if the page has one; never stored, never logged
        state.kind = KINDS.has(body.kind) ? body.kind : 'simple';
        if (notepad && !session.state().running) await notepad.begin(String(body.task || '').slice(0, 120));   // a fresh Notepad page for this run
        const r = session.start(body.task, { maxMinutes: [15, 45, 90, 240].includes(Number(body.minutes)) ? Number(body.minutes) : 45 });
        if (r.ok) wipeWhenDone(); else if (!session.state().running) { state.token = ''; state.gh = ''; }
        send(res, r.ok ? 200 : 409, r.ok ? { ok: true, id: r.id } : { error: r.error }); return true;
      }
      if (p === '/api/codebase/token' && method === 'POST') {
        // A long job outlives a login (about an hour). The page sends the refreshed one; it only replaces the token of a job that is running right now. Kept in memory, never stored.
        const tk = String(req.headers['x-pholama-token'] || '').slice(0, 4000);
        const st = session.state();
        if (!tk || !st.running || st.done) { send(res, 409, { error: 'No job is running.' }); return true; }
        state.token = tk; send(res, 200, { ok: true }); return true;
      }
      if (p === '/api/codebase/answer' && method === 'POST') {
        const r = session.answer(String(body.run || ''), String(body.call || ''), body.allow === true);
        send(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: r.error }); return true;
      }
      if (p === '/api/codebase/say' && method === 'POST') {   // a message typed while the agent is working
        if (!session.state().running) { send(res, 409, { error: 'The agent is not running. Press Start to give it a task.' }); return true; }
        const x = inbox.add(body.text); send(res, x.ok ? 200 : 400, x.ok ? { ok: true } : { error: x.error }); return true; }
      if (p === '/api/codebase/stop' && method === 'POST') { const r = session.stop(); state.token = ''; state.gh = ''; if (r.ok && notepad) notepad.finish().catch(() => {}); send(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: r.error }); return true; }
      if (p === '/api/codebase/memory' && method === 'POST') { const x = MEM.remember(String(body.text || '')); send(res, x.ok ? 200 : 400, x.ok ? { ok: true, memory: MEM.listMemory() } : { error: x.text }); return true; }
      if (p === '/api/codebase/memory' && method === 'DELETE') { if (body.all === true) { MEM.clearMemory(); send(res, 200, { ok: true, memory: [] }); return true; } const x = MEM.forget(String(body.id || '')); send(res, x.ok ? 200 : 404, x.ok ? { ok: true, memory: MEM.listMemory() } : { error: x.text }); return true; }
      if (p === '/api/codebase/sessions' && method === 'DELETE') { if (body.all === true) { MEM.clearSessions(); send(res, 200, { ok: true, sessions: [] }); return true; } const x = MEM.deleteSession(String(body.id || '')); send(res, x.ok ? 200 : 404, x.ok ? { ok: true, sessions: MEM.listSessions() } : { error: 'No such session.' }); return true; }
      if (p === '/api/codebase/always' && method === 'POST') { const r2 = require('./codebase-always').add(String(body.tool || '')); send(res, r2.ok ? 200 : 400, r2); return true; }
      if (p === '/api/codebase/always' && method === 'DELETE') { const A = require('./codebase-always'); send(res, 200, body.tool ? A.remove(String(body.tool)) : A.clear()); return true; }
      if (p === '/api/codebase/grants' && method === 'POST') {
        try { const g = grants.grant(String(body.dir || ''), body.mode === 'write' ? 'write' : 'read'); send(res, 200, { ok: true, grant: g, grants: grants.list() }); }
        catch (e) { send(res, 400, { error: String(e && e.message || 'That folder cannot be used.').slice(0, 200) }); }
        return true;
      }
      if (p === '/api/codebase/grants' && method === 'DELETE') { send(res, 200, { ok: grants.revoke(String(body.dir || '')), grants: grants.list() }); return true; }
      send(res, 404, { error: 'Not available.' }); return true;
    } catch (e) {
      log('codebase api error: ' + String(e && e.message || e).slice(0, 160));
      if (!res.headersSent) send(res, 500, { error: plain(e) }); else { try { res.end(); } catch {} }
      return true;
    }
  }
  return { handle, session, state, tools, MAX_UPLOAD };
}
module.exports = { create, buildTools, readBody, MAX_BODY, MAX_UPLOAD };
