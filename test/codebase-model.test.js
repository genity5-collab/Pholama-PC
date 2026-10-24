'use strict';
const M = require('../server/codebase-model');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const SECRETS = ['qwen3-coder', 'qwen-coder', 'free.ai', 'openrouter', 'HTTP 5', 'self_hosted', 'self-hosted', 'pholamaCloud', 'Deno', 'supabase'];

// a fake cloud: records the request, answers as told
function cloud(answer) {
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, o, body: JSON.parse(o.body) });
    if (answer instanceof Error) throw answer;
    const a = typeof answer === 'function' ? answer(calls.length) : answer;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.badJson) throw new Error('x'); return a.json || {}; } };
  };
  return { fetchFn, calls };
}
const OK = { status: 200, json: { reply: '<tool>{"name":"done","summary":"ok"}</tool>', credits_left: 1400, week_cap: 1500, cost: 25 } };
const MSGS = [{ role: 'system', content: 'RULES' }, { role: 'user', content: 'fix the menu' }];

(async () => {
  // ---- which model ----
  ok('simple work uses qwen-coder', M.pickModel('simple') === 'qwen-coder');
  ok('hard work uses qwen3-coder', M.pickModel('hard') === 'qwen3-coder');
  for (const k of [undefined, null, '', 'x', 'qwen7b', 'mistral', 'gpt-4', 'constructor', '__proto__', 5, {}, [], 'HARD', ' hard']) ok('unknown kind falls back to the cheap coder, never an unlisted model: ' + JSON.stringify(k), M.pickModel(k) === 'qwen-coder');
  ok('the model table cannot be changed', Object.isFrozen(M.MODELS));
  let c = cloud(OK); await M.ask({ token: 't', messages: MSGS, kind: 'hard', fetchFn: c.fetchFn });
  ok('the request names qwen3-coder for hard work', c.calls[0].body.model === 'qwen3-coder');
  c = cloud(OK); await M.ask({ token: 't', messages: MSGS, fetchFn: c.fetchFn });
  ok('the request names qwen-coder by default', c.calls[0].body.model === 'qwen-coder');

  // ---- what is sent ----
  const b = c.calls[0].body;
  ok('it asks for Codebase mode (studio + codebase)', b.studio === true && b.codebase === true);
  ok('the login goes in the Authorization header only', c.calls[0].o.headers.Authorization === 'Bearer t' && !JSON.stringify(b).includes('"t"'));
  ok('the rules go first as the system message', b.messages[0].role === 'system' && b.messages[0].content === 'RULES');
  ok('the task is sent as typed', b.messages[1].role === 'user' && b.messages[1].content === 'fix the menu');
  ok('it goes to the cloud function address', /pholamaCloud$/.test(c.calls[0].url));
  ok('a custom address is respected (tests, self-hosting)', await (async () => { const k = cloud(OK); await M.ask({ token: 't', messages: MSGS, fetchFn: k.fetchFn, url: 'http://x/y' }); return k.calls[0].url === 'http://x/y'; })());
  ok('no PC folder names, grants or files are sent beyond the messages', Object.keys(b).sort().join() === 'codebase,effort,localTools,messages,model,studio');

  // ---- billing: only the person's words are billed ----
  const long = [{ role: 'system', content: 'R' }, { role: 'user', content: 'build a shop' }, { role: 'assistant', content: '<tool>{"name":"note_","text":"plan"}</tool>' }, { role: 'user', content: 'RESULT: ' + 'word '.repeat(900) }];
  c = cloud(OK); await M.ask({ token: 't', messages: long, fetchFn: c.fetchFn });
  let sent = c.calls[0].body.messages, last = sent[sent.length - 1].content;
  ok('a tool result is moved after the [Studio] marker', last.includes(M.MARK) && last.indexOf(M.MARK) < last.indexOf('RESULT:'));
  ok('the words before the marker are only a short stub (so almost nothing is billed)', last.slice(0, last.indexOf(M.MARK)).trim().split(/\s+/).length <= 2);
  for (const own of ['REFUSED: not allowed', 'EARLIER WORK (12 older messages were shortened)', 'Reply with exactly one <tool> line']) {
    c = cloud(OK); await M.ask({ token: 't', messages: [{ role: 'system', content: 'R' }, { role: 'user', content: 'task' }, { role: 'user', content: own }], fetchFn: c.fetchFn });
    const l = c.calls[0].body.messages.slice(-1)[0].content; ok('agent-written text is free: ' + own.slice(0, 20), l.includes(M.MARK) && l.slice(0, l.indexOf(M.MARK)).trim().split(/\s+/).length <= 2);
  }
  c = cloud(OK); await M.ask({ token: 't', messages: [{ role: 'system', content: 'R' }, { role: 'user', content: 'RESULTS: please fix my RESULT: page' }], fetchFn: c.fetchFn });
  ok('a task that merely starts with similar words is still the person\'s and is billed as typed', !c.calls[0].body.messages.slice(-1)[0].content.includes(M.MARK));
  c = cloud(OK); await M.ask({ token: 't', messages: [{ role: 'system', content: 'R' }, { role: 'user', content: 'RESULT: x' + M.MARK + 'already shaped' }], fetchFn: c.fetchFn });
  ok('a message that already has the marker is not changed twice', (c.calls[0].body.messages.slice(-1)[0].content.match(/\[Studio\]/g) || []).length === 1);
  c = cloud(OK); await M.ask({ token: 't', messages: [{ role: 'system', content: 'R' }, { role: 'user', content: 'a person types [Studio] in the task' }], fetchFn: c.fetchFn });
  ok('the person typing the word [Studio] cannot hide anything (only the exact marker line counts, and the task is untouched)', c.calls[0].body.messages.slice(-1)[0].content === 'a person types [Studio] in the task');
  ok('assistant messages are never changed', (() => { const k = cloud(OK); return M.shape([{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'RESULT: not mine' }, { role: 'user', content: 'RESULT: r' }]).msgs[1].content === 'RESULT: not mine'; })());

  // ---- shaping ----
  const many = [{ role: 'system', content: 'S' }, ...Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }))];
  const sh = M.shape(many);
  ok('a long history is trimmed to the newest ' + M.KEEP_OTHER, sh.msgs.length === M.KEEP_OTHER && sh.msgs[sh.msgs.length - 1].content === 'm99');
  ok('the rules are always kept', sh.sys === 'S');
  ok('no system message gives empty rules, not a crash', M.shape([{ role: 'user', content: 'x' }]).sys === '');
  for (const bad of [null, undefined, 5, 'x', {}, [null], [5], [{}], [{ role: 'user' }], [{ role: 'user', content: 5 }], [{ role: 'tool', content: 'x' }]]) ok('junk messages do not crash shape: ' + JSON.stringify(bad), (() => { try { M.shape(bad); return true; } catch { return false; } })());
  for (const bad of [null, undefined, [], [{ role: 'system', content: 'R' }], [{ role: 'system', content: 'R' }, { role: 'assistant', content: 'a' }]]) {
    let e = null; try { await M.ask({ token: 't', messages: bad, fetchFn: cloud(OK).fetchFn }); } catch (x) { e = x; }
    ok('no user message at the end: refused before calling the cloud: ' + JSON.stringify(bad), e && e.plain === true);
  }

  // ---- the answer ----
  const r = await M.ask({ token: 't', messages: MSGS, fetchFn: cloud(OK).fetchFn });
  ok('the reply text comes back whole', r.text === OK.json.reply);
  ok('the credits left come back for the page', r.credits && r.credits.left === 1400 && r.credits.cap === 1500 && r.credits.cost === 25);
  ok('no credits info is fine', (await M.ask({ token: 't', messages: MSGS, fetchFn: cloud({ status: 200, json: { reply: 'x' } }).fetchFn })).credits === null);
  const long25 = 'z'.repeat(25000); ok('a 25,000 character reply is not cut', (await M.ask({ token: 't', messages: MSGS, fetchFn: cloud({ status: 200, json: { reply: long25 } }).fetchFn })).text.length === 25000);

  // ---- errors: plain words only, no provider or model details ----
  const cases = [
    ['no token', null, 'login'], ['blank token', null, 'login'],
    ['HTTP 401', { status: 401, json: { error: 'Invalid JWT from supabase', code: 'login' } }, 'login'],
    ['code login', { status: 400, json: { code: 'login' } }, 'login'],
    ['out of credits (429)', { status: 429, json: { error: 'Not enough credits (3 left, this message needs 50)', code: 'limit-month' } }, 'limit'],
    ['day limit code', { status: 429, json: { code: 'limit-day', error: 'x' } }, 'limit'],
    ['plain 429', { status: 429, json: {} }, 'limit'],
    ['500 from the cloud', { status: 500, json: { error: 'Agent Max did not answer. cloud provider returned a paid model qwen3-coder', code: 'server' } }, 'busy'],
    ['502 bad gateway', { status: 502, json: { error: 'HTTP 502 from free.ai openrouter' } }, 'busy'],
    ['400 model not available', { status: 400, json: { error: 'That cloud model is not available.', code: 'model' } }, 'busy'],
    ['unreadable body on error', { status: 500, badJson: true }, 'busy'],
    ['empty reply', { status: 200, json: { reply: '' } }, 'busy'],
    ['whitespace reply', { status: 200, json: { reply: '   \n ' } }, 'busy'],
    ['no reply field', { status: 200, json: {} }, 'busy'],
    ['unreadable body on 200', { status: 200, badJson: true }, 'busy'],
    ['the network is down', new TypeError('fetch failed: getaddrinfo ENOTFOUND lyra-09dfabbf.base44.app'), 'network'],
  ];
  for (const [name, answer, kind] of cases) {
    const logs = []; let e = null;
    try { await M.ask({ token: name.includes('blank') ? '   ' : name === 'no token' ? '' : 't', messages: MSGS, fetchFn: cloud(answer || OK).fetchFn, log: s => logs.push(s) }); } catch (x) { e = x; }
    ok(name + ': fails with kind ' + kind, e && e.kind === kind);
    ok(name + ': the message is one plain sentence', e && e.plain === true && e.message === M.PLAIN[kind]);
    ok(name + ': nothing technical in what the person sees', e && !SECRETS.some(s => e.message.toLowerCase().includes(s.toLowerCase())) && !/\b(HTTP|5\d\d|4\d\d)\b/.test(e.message));
    if (answer && answer.status >= 400 || answer instanceof Error) ok(name + ': the real reason is only in the log', logs.length >= 1);
  }
  ok('the token never appears in the log', await (async () => { const logs = []; try { await M.ask({ token: 'SECRET-TOKEN-1', messages: MSGS, fetchFn: cloud({ status: 500, json: {} }).fetchFn, log: s => logs.push(s) }); } catch {} return logs.length && !logs.join().includes('SECRET-TOKEN-1'); })());

  // ---- stopping ----
  const ac = new AbortController(); let e = null;
  const hang = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const x = new Error('aborted'); x.name = 'AbortError'; rej(x); }));
  const p = M.ask({ token: 't', messages: MSGS, fetchFn: hang, signal: ac.signal }); ac.abort();
  try { await p; } catch (x) { e = x; }
  ok('Stop aborts the request', e && e.kind === 'stopped' && e.message === 'Stopped.');
  e = null; const ac2 = new AbortController(); ac2.abort(); try { await M.ask({ token: 't', messages: MSGS, fetchFn: hang, signal: ac2.signal }); } catch (x) { e = x; }
  ok('an already-stopped run does not even start the request', e && e.kind === 'stopped');
  e = null; const k = cloud(OK); let sawSignal = false; try { await M.ask({ token: 't', messages: MSGS, fetchFn: (u, o) => { sawSignal = !!o.signal; return k.fetchFn(u, o); } }); } catch {}
  ok('without a signal a time limit is still set', sawSignal);

  // ---- makeModel: what the loop calls ----
  const seenCredits = []; c = cloud(OK);
  const model = M.makeModel({ getToken: () => 'tok', fetchFn: c.fetchFn, onCredits: x => seenCredits.push(x) });
  ok('makeModel returns the reply text', (await model(MSGS)) === OK.json.reply);
  ok('makeModel reports the credits', seenCredits.length === 1 && seenCredits[0].left === 1400);
  ok('a crashing onCredits never breaks the run', await (async () => { const mm = M.makeModel({ getToken: 'tok', fetchFn: cloud(OK).fetchFn, onCredits: () => { throw new Error('ui'); } }); return (await mm(MSGS)) === OK.json.reply; })());
  let kind = 'simple'; c = cloud(OK); const m2 = M.makeModel({ getToken: () => 'tok', getKind: () => kind, fetchFn: c.fetchFn });
  await m2(MSGS); kind = 'hard'; await m2(MSGS);
  ok('the model can change between turns', c.calls[0].body.model === 'qwen-coder' && c.calls[1].body.model === 'qwen3-coder');
  let tk = 'one'; c = cloud(OK); const m3 = M.makeModel({ getToken: () => tk, fetchFn: c.fetchFn }); await m3(MSGS); tk = 'two'; await m3(MSGS);
  ok('the token is read fresh each turn (a re-login mid-run works)', c.calls[0].o.headers.Authorization === 'Bearer one' && c.calls[1].o.headers.Authorization === 'Bearer two');
  e = null; try { await M.makeModel({ getToken: () => '', fetchFn: cloud(OK).fetchFn })(MSGS); } catch (x) { e = x; }
  ok('no token through makeModel is a plain sign-in message', e && e.kind === 'login');
  e = null; try { await M.makeModel({})(MSGS); } catch (x) { e = x; }
  ok('makeModel with nothing configured fails plainly, not with a crash', e && e.plain === true);

  // ---- the cloud's <tool_call> swap is undone (found in a REAL run: every reply was thrown away) ----
  { const L = require('../server/codebase-loop');
    const REAL = '<tool_call>{"name":"pull_file","path":"/app/x/readme.txt"}</tool_call>';   // exactly what the live cloud returned
    const got = await M.ask({ token: 't', messages: MSGS, fetchFn: cloud({ status: 200, json: { reply: REAL } }).fetchFn });
    ok('the real cloud reply comes back in the form the loop reads', got.text === '<tool>{"name":"pull_file","path":"/app/x/readme.txt"}</tool>');
    ok('and the loop can parse it', L.parse(got.text) && L.parse(got.text).name === 'pull_file');
    ok('keys are never renamed (the loop unwraps them)', M.fromCloud('<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>') === '<tool>{"name":"x","arguments":{"a":1}}</tool>');
    ok('already-plain text is unchanged', M.fromCloud('<tool>{"name":"done"}</tool>') === '<tool>{"name":"done"}</tool>');
    ok('upper case tags are handled too', M.fromCloud('<TOOL_CALL>{}</TOOL_CALL>') === '<tool>{}</tool>');
    ok('plain words are not touched', M.fromCloud('I will read the file') === 'I will read the file');
    for (const bad of [null, undefined, 5, {}, []]) ok('junk reply does not crash fromCloud: ' + JSON.stringify(bad), typeof M.fromCloud(bad) === 'string');
    ok('the code a file contains is not damaged by the swap', M.fromCloud('<tool_call>{"name":"edit_file","content":"x = 1"}</tool_call>').includes('"content":"x = 1"')); }

  // ---- the per-call signal (this is how Stop reaches the request) ----
  { const ac3 = new AbortController(); let err = null;
    const hang2 = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const x = new Error('aborted'); x.name = 'AbortError'; rej(x); }));
    const mm = M.makeModel({ getToken: () => 'tok', fetchFn: hang2 });
    const pr = mm(MSGS, ac3.signal); ac3.abort(); try { await pr; } catch (x) { err = x; }
    ok('a signal passed on the call cancels that request', err && err.kind === 'stopped'); }
  { const ac4 = new AbortController(); ac4.abort(); let err = null, hit = 0;
    try { await M.makeModel({ getToken: () => 'tok', fetchFn: async () => { hit++; return { ok: true, status: 200, json: async () => ({ reply: 'x' }) }; } })(MSGS, ac4.signal); } catch (x) { err = x; }
    ok('an already-stopped call sends nothing', err && err.kind === 'stopped' && hit === 0); }
  { const acA = new AbortController(); let hit2 = 0;
    const mm = M.makeModel({ getToken: () => 'tok', signal: acA.signal, fetchFn: async (u, o) => { hit2++; return { ok: true, status: 200, json: async () => ({ reply: 'fine' }) }; } });
    ok('with no per-call signal the creation signal still works', (await mm(MSGS)) === 'fine');
    const acB = new AbortController();
    ok('a per-call signal wins over the creation signal', (await mm(MSGS, acB.signal)) === 'fine' && hit2 === 2); }

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
