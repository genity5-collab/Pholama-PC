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

const MAX_BODY = 64 * 1024;          // a task, an answer or a grant is small; a bigger body is refused before it is read in full
const MAX_UPLOAD = 8 * 1024 * 1024;  // a screenshot or a picture the person attaches
const KINDS = new Set(['simple', 'hard']);

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
  const { win, github, media, opened = new Set(), getGithubToken = () => '', readImage, fetchFn } = deps;
  const tools = {};
  for (const meta of T.list()) {
    const name = meta.name;
    tools[name] = async args => {
      const pl = PLAN.plan(name, args);
      if (!pl || pl.ok !== true) return 'REFUSED: ' + ((pl && pl.say) || 'not allowed');
      if (pl.kind === 'next_task') return 'Next task started.';
      if (pl.kind === 'note') { if (!deps.notepad) return 'Noted.'; const n = await deps.notepad.note(pl.text); return n.ok ? 'Noted.' + (n.live ? ' (shown in Notepad)' : '') : 'ERROR: ' + n.text; }
      let r;
      if (pl.kind === 'github_read' || pl.kind === 'github_write') r = await github.execute(pl, { token: getGithubToken(), fetchFn });
      else if (media && typeof media.execute === 'function' && /^make_/.test(name)) r = await media.execute(pl, {});
      else r = await win.execute(pl, { opened, readImage });
      return r && r.ok ? String(r.text == null ? 'Done.' : r.text) : 'ERROR: ' + String((r && r.text) || 'it did not work');
    };
  }
  return tools;
}

function create(deps) {
  const { grants, budget, now = Date.now, log = () => {}, fetchFn, cloudUrl } = deps;
  const state = { token: '', gh: '', kind: 'simple', credits: null };   // both tokens live in memory for ONE run only
  const model = MODEL.makeModel({ getToken: () => state.token, getKind: () => state.kind, fetchFn, url: cloudUrl, log, onCredits: c => { state.credits = c; } });
  const notepad = deps.notepad === undefined ? (deps.win ? require('./codebase-notepad').create({
    write: async (f, c) => { const r = await deps.win.execute({ ok: true, kind: 'write', path: f, content: c, append: false }, {}); if (!r.ok) throw new Error('write'); },
    append: async (f, c) => { const r = await deps.win.execute({ ok: true, kind: 'write', path: f, content: c, append: true }, {}); if (!r.ok) throw new Error('append'); },
    open: async f => deps.win.execute({ ok: true, kind: 'notepad', path: f }, {}),
    close: async title => deps.win.execute({ ok: true, kind: 'close', title }, {}),   // no 'opened' set is passed, so this closes only the Pholama notes window by its exact title
  }) : null) : deps.notepad;
  const tools = deps.tools || buildTools({ ...deps, notepad, getGithubToken: deps.getGithubToken || (() => state.gh) });
  const session = SESSION.create({ model, tools, budget, now });
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
      if (p === '/api/codebase/state' && method === 'GET') { send(res, 200, { ...session.state(), usage: budget.view(budget.load(now()), now()), grants: grants.list(), credits: state.credits }); return true; }
      if (p === '/api/codebase/stream' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...(res.cors || {}) });
        const out = e => { try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch {} };
        const stop = session.watch(out);
        if (!stop) { res.end('event: empty\ndata: {}\n\n'); return true; }
        res.write(': hello\n\n'); const beat = setInterval(() => { try { res.write(': \n\n'); } catch {} }, 20000); if (beat.unref) beat.unref();
        const done = () => { clearInterval(beat); stop(); }; req.on('close', done); res.on('error', done); return true;
      }
      if (p === '/api/codebase/usage' && method === 'GET') {   // the usage bar on the page: 5,000 / 7-hour rests / 15,000 per month
        let tz = 'UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch {}
        send(res, 200, { ...budget.view(budget.load(now()), now()), now: now(), tz }); return true;
      }
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
        const r = session.start(body.task);
        if (r.ok) wipeWhenDone(); else if (!session.state().running) { state.token = ''; state.gh = ''; }
        send(res, r.ok ? 200 : 409, r.ok ? { ok: true, id: r.id } : { error: r.error }); return true;
      }
      if (p === '/api/codebase/answer' && method === 'POST') {
        const r = session.answer(String(body.run || ''), String(body.call || ''), body.allow === true);
        send(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: r.error }); return true;
      }
      if (p === '/api/codebase/stop' && method === 'POST') { const r = session.stop(); state.token = ''; state.gh = ''; if (r.ok && notepad) notepad.finish().catch(() => {}); send(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: r.error }); return true; }
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
