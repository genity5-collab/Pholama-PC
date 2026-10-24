// Attacks on the Codebase screen: hostile AI text must never become live HTML, approvals must be exact, errors name no model.
import { describe, rowHtml, endLine, mountCodebase } from '../web/codebasescreen.js';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

const EVIL = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>', "' onmouseover='alert(1)", '`<b>x</b>`', '</li><li class="x">', '&lt;b&gt;', 'javascript:alert(1)', '<iframe src=//evil>', '\u202e<b>'];
const OWN = /<\/?(li|span|div|b|pre|button|em)( (class|data-call|data-allow|data-always|title)="[^"<>]*")*>/g;
const live = html => html.replace(OWN, '').includes('<');

// ---- describe: every event kind ----
ok('a tool call is described', describe({ kind: 'tool', tool: 'edit_file', args: '{"path":"a.js"}', result: 'Done.', cost: 0 }).tag === 'TOOL');
ok('a failed tool is shown as bad', describe({ kind: 'tool', tool: 'x', result: 'REFUSED: no' }).tone === 'bad' && describe({ kind: 'tool', tool: 'x', result: 'ERROR: no' }).tone === 'bad');
ok('a note is described as a note', describe({ kind: 'tool', tool: 'note_', args: '{"text":"plan the page"}' }).tag === 'NOTE');
ok('a note shows its text, not the JSON', /plan the page/.test(describe({ kind: 'tool', tool: 'note_', args: '{"text":"plan the page"}' }).text) && !/\{"text"/.test(describe({ kind: 'tool', tool: 'note_', args: '{"text":"plan the page"}' }).text));
ok('an approval carries its call id', describe({ kind: 'ask', tool: 'edit_file', callId: 'c1', level: 'normal' }).callId === 'c1');
ok('a strict approval is marked', describe({ kind: 'ask', tool: 'delete_folder_or_window_or_app', callId: 'c2', level: 'strict' }).strict === true);
ok('answered Yes / No', /Yes/.test(describe({ kind: 'answered', allowed: true }).text) && /No/.test(describe({ kind: 'answered', allowed: false }).text));
ok('expired approval says it was not done', /not done/.test(describe({ kind: 'expired' }).text));
ok('refused, retry, stopped, done all describe', ['refused', 'retry', 'stopped', 'done'].every(k => describe({ kind: k, say: 'hi' })));
for (const k of ['end', 'hello', 'weird', '', undefined]) ok('kind ' + JSON.stringify(k) + ' stays out of the feed', describe({ kind: k }) === null);
for (const j of [null, undefined, 5, 'x', [], true]) ok('junk event does not crash: ' + JSON.stringify(j), (() => { try { describe(j); return true; } catch { return false; } })());

// ---- rowHtml: hostile text ----
for (const evil of EVIL) {
  const rows = [
    rowHtml(describe({ kind: 'tool', tool: 'edit_file', args: evil, result: evil })),
    rowHtml(describe({ kind: 'ask', tool: evil, callId: evil, args: evil, level: 'strict' })),
    rowHtml(describe({ kind: 'done', say: evil })), rowHtml(describe({ kind: 'refused', say: evil })), rowHtml(describe({ kind: 'stopped', say: evil })),
    rowHtml(describe({ kind: 'tool', tool: 'note_', args: '{"text":"' + evil + '"}' })),
  ];
  ok('no live HTML from: ' + evil.slice(0, 24), rows.every(h => !live(h)));
}
// Real attribute NAMES only: walk each tag and skip quoted values, so escaped text that merely contains the word onclick= cannot fool the check.
const attrNames = html => { const names = []; const tag = /<[a-z0-9]+((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/gi; let m; while ((m = tag.exec(html))) { const re = /\s+([a-z-]+)(?:="[^"]*")?/gi; let a; while ((a = re.exec(m[1]))) names.push(a[1].toLowerCase()); } return names; };
{ const h = rowHtml(describe({ kind: 'ask', tool: 'x" onclick="y', callId: 'a" onmouseover="b', args: 'q' }));
  ok('no event handler attribute can appear (real attribute names only)', attrNames(h).every(n => ['class', 'data-call', 'data-allow', 'data-always', 'title'].includes(n)));
  ok('the quotes in hostile text are escaped, so they cannot close an attribute', !/data-call="[^"]*"[^>]*onmouseover/.test(h) && h.includes('&quot;')); }
ok('a hostile call id cannot break out of data-call', (() => { const h = rowHtml(describe({ kind: 'ask', tool: 'x', callId: '"><script>1</script>' })); return !h.includes('<script') && /data-call="&quot;&gt;/.test(h); })());
ok('rowHtml of nothing is empty', rowHtml(null) === '' && rowHtml(undefined) === '');
ok('an Allow and a Deny button exist on an approval', (() => { const h = rowHtml(describe({ kind: 'ask', tool: 'edit_file', callId: 'c' })); return /data-allow="1"/.test(h) && /data-allow="0"/.test(h); })());
ok('a normal tool row has no buttons', !/<button/.test(rowHtml(describe({ kind: 'tool', tool: 'edit_file', args: 'a', result: 'ok' }))));
ok('long text is cut', rowHtml(describe({ kind: 'done', say: 'x'.repeat(9000) })).length < 2000);

// ---- endLine ----
ok('finished line counts steps', endLine({ ok: true, steps: 3 }) === 'Finished in 3 steps.' && endLine({ ok: true, steps: 1 }) === 'Finished in 1 step.');
ok('stuck is said calmly', /stuck/.test(endLine({ ok: false, stopped: 'stuck' })));
for (const s of ['user', 'credits', 'time', 'paused', 'zzz', null]) ok('stop reason ' + s + ' reads fine and names no model', !/qwen|free\.ai|http|model/i.test(endLine({ ok: false, stopped: s })));
ok('no result, no line', endLine(null) === '');

// ---- a small fake page so the click handlers can be driven ----
function fakePage() {
  const els = {}; const mk = (id, extra = {}) => (els[id] = { id, value: '', disabled: false, textContent: '', className: '', innerHTML: '', dataset: {}, children: [], listeners: {}, onclick: null, addEventListener(t, f) { this.listeners[t] = f; }, querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML(_, h) { this.innerHTML += h; this.children.push({}); }, removeChild() { this.children.shift(); }, get firstChild() { return this.children[0]; }, get lastElementChild() { return null; }, ...extra });
  ['#cbsTask', '#cbsKind', '#cbsStart', '#cbsStop', '#cbsMsg', '#cbsFeed', '#cbsGrants', '#cbsDir', '#cbsMode', '#cbsGrant', '#cbsAlways', '#cbsAlwaysOff', '#cbsClear', '#cbsMinutes'].forEach(k => mk(k));
  els['#cbsKind'].value = 'simple'; els['#cbsMinutes'].value = '45'; els['#cbsMode'].value = 'read';
  const root = { innerHTML: '', querySelector: s => els[s] || null };
  return { root, els };
}
const reply = (status, j) => ({ ok: status < 400, status, json: async () => j });
function boot(routes, o = {}) {
  const calls = []; const { root, els } = fakePage();
  const fetchFn = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null }); const h = routes[(init.method || 'GET') + ' ' + url]; return h ? reply(...(typeof h === 'function' ? h(init) : h)) : reply(404, { error: 'no' }); };
  const scr = mountCodebase(root, { fetchFn, getToken: () => (o.token === undefined ? 'LOGIN' : o.token), getGithubToken: () => o.gh || '', EventSourceCtor: null });
  return { calls, els, scr };
}

// ---- Start ----
{ const t = boot({ 'POST /api/codebase/start': [200, { ok: true, id: 'r1' }], 'GET /api/codebase/state': [200, { running: false }] });
  t.els['#cbsTask'].value = '   '; await t.els['#cbsStart'].onclick();
  ok('an empty task asks for words and calls nothing', t.calls.length === 0 && /Write what/.test(t.els['#cbsMsg'].textContent)); }
{ const t = boot({}, { token: '' }); t.els['#cbsTask'].value = 'do it'; await t.els['#cbsStart'].onclick();
  ok('no login: tells the person to sign in and calls nothing', t.calls.length === 0 && /Sign in/.test(t.els['#cbsMsg'].textContent)); }
{ const t = boot({ 'POST /api/codebase/start': [200, { ok: true, id: 'r1' }] }, { token: 'LOGIN', gh: 'GH' }); t.els['#cbsTask'].value = 'make a page'; t.els['#cbsKind'].value = 'hard'; await t.els['#cbsStart'].onclick();
  const c = t.calls[0];
  ok('Start posts to the start route once', t.calls.length === 1 && c.url === '/api/codebase/start' && c.method === 'POST');
  ok('the login goes in a header, never the body', c.headers['x-pholama-token'] === 'LOGIN' && !JSON.stringify(c.body).includes('LOGIN'));
  ok('the GitHub token goes in a header, never the body', c.headers['x-github-token'] === 'GH' && !JSON.stringify(c.body).includes('GH'));
  ok('the job kind is hard or simple (the server only knows those)', c.body.kind === 'hard');
  ok('the task is sent', c.body.task === 'make a page');
  ok('while running Start is off and Stop is on', t.els['#cbsStart'].disabled === true && t.els['#cbsStop'].disabled === false); }
{ const t = boot({ 'POST /api/codebase/start': [200, { ok: true, id: 'r1' }] }, { token: 'LOGIN' }); t.els['#cbsTask'].value = 'x'; await t.els['#cbsStart'].onclick();
  ok('with no GitHub token no GitHub header is sent', !('x-github-token' in t.calls[0].headers)); }
{ const t = boot({ 'POST /api/codebase/start': [409, { error: 'A task is already running.' }] }); t.els['#cbsTask'].value = 'x'; await t.els['#cbsStart'].onclick();
  ok('a refused start shows the reason and frees the buttons', /already running/.test(t.els['#cbsMsg'].textContent) && t.els['#cbsStart'].disabled === false && t.els['#cbsStop'].disabled === true); }
{ const t = boot({ 'POST /api/codebase/start': [401, { error: 'Please sign in again.' }] }); t.els['#cbsTask'].value = 'x'; await t.els['#cbsStart'].onclick();
  ok('a bad login shows the plain message', /sign in/i.test(t.els['#cbsMsg'].textContent)); }

// ---- Stop ----
{ const t = boot({ 'POST /api/codebase/stop': [200, { ok: true }] }); await t.els['#cbsStop'].onclick();
  ok('Stop posts to the stop route', t.calls.length === 1 && t.calls[0].url === '/api/codebase/stop' && t.calls[0].method === 'POST'); }
{ const t = boot({ 'POST /api/codebase/stop': [409, { error: 'Nothing is running.' }] }); await t.els['#cbsStop'].onclick();
  ok('Stop with nothing running says so', /Nothing/.test(t.els['#cbsMsg'].textContent)); }

// ---- folders ----
{ const t = boot({ 'POST /api/codebase/grants': [200, { ok: true, grants: [{ dir: 'C:\\p', mode: 'write' }] }] }); t.els['#cbsDir'].value = 'C:\\p'; t.els['#cbsMode'].value = 'write'; await t.els['#cbsGrant'].onclick();
  ok('granting posts the folder and the mode', t.calls[0].body.dir === 'C:\\p' && t.calls[0].body.mode === 'write');
  ok('the folder list is shown', /C:\\p/.test(t.els['#cbsGrants'].innerHTML) && /read \+ change/.test(t.els['#cbsGrants'].innerHTML));
  ok('the box is cleared after', t.els['#cbsDir'].value === ''); }
{ const t = boot({}); t.els['#cbsDir'].value = '  '; await t.els['#cbsGrant'].onclick(); ok('an empty folder calls nothing', t.calls.length === 0); }
{ const t = boot({ 'POST /api/codebase/grants': [400, { error: 'That folder is not allowed.' }] }); t.els['#cbsDir'].value = 'C:\\Windows'; await t.els['#cbsGrant'].onclick();
  ok('a refused folder shows why', /not allowed/.test(t.els['#cbsMsg'].textContent)); }
{ const t = boot({ 'GET /api/codebase/grants': [200, { grants: [{ dir: '<img src=x onerror=alert(1)>', mode: 'read' }] }] }); await t.scr.paintGrants();
  ok('a hostile folder name is escaped in the list', !live(t.els['#cbsGrants'].innerHTML.replace(/<\/?(ul|button)[^>]*>/g, '')) && !/<img/.test(t.els['#cbsGrants'].innerHTML)); }
{ const t = boot({ 'GET /api/codebase/grants': [200, { grants: [] }] }); await t.scr.paintGrants(); ok('no folders says so', /No folders/.test(t.els['#cbsGrants'].innerHTML)); }

// ---- reopening the page during a run ----
{ const t = boot({ 'GET /api/codebase/grants': [200, { grants: [] }], 'GET /api/codebase/state': [200, { running: true, id: 'r9' }] }); await t.scr.open();
  ok('a run already going is picked up (buttons reflect it)', t.els['#cbsStart'].disabled === true && t.els['#cbsStop'].disabled === false); }
{ const t = boot({ 'GET /api/codebase/grants': [200, { grants: [] }], 'GET /api/codebase/state': [200, { running: false }] }); await t.scr.open();
  ok('no run going leaves Start on', t.els['#cbsStart'].disabled === false); }
{ const t = boot({}); await t.scr.open(); ok('the server being down does not crash the screen', true); }

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
