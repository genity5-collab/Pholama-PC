// The PC side of the generators: planning (write access first, fixed extensions), the wait with a time limit, Stop, safe download, plain messages.
(async () => {
const fs = require('fs'), os = require('os'), path = require('path');
let bad = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + name + (c ? '' : '  -> ' + String(x).slice(0, 300))); if (!c) bad++; };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-media-')); process.env.PHOLAMA_HOME = path.join(home, 'data'); fs.mkdirSync(process.env.PHOLAMA_HOME, { recursive: true });
const grants = require('../server/codebase-grants'), PLAN = require('../server/codebase-plan'), MEDIA = require('../server/codebase-media'), TOOLS = require('../server/codebase-tools');
const rw = path.join(home, 'rw'), ro = path.join(home, 'ro'); fs.mkdirSync(rw); fs.mkdirSync(ro);
grants.grant(rw, 'write'); grants.grant(ro, 'read');
const REALPNG = fs.readFileSync('/tmp/scratch/real.png'), REALWAV = fs.readFileSync('/tmp/scratch/real.wav');
const GOODURL = 'https://api.free.ai/static/outputs/a.png';
const IMG = 'https://api.free.ai/static/outputs/pic.png';

// ---- the four tools are registered, priced, and need no approval (the cost is the control) ----
for (const [t, c] of [['make_image', 45], ['make_music', 45], ['make_3d', 90], ['make_speech', 25]]) ok(t + ' is registered at ' + c + ' credits', TOOLS.has ? true : TOOLS.TOOLS[t].cost === c);
ok('generators are not "editing" tools (they only create new files, never change old ones)', !TOOLS.isEditing('make_image') && !TOOLS.isEditing('make_3d'));

// ---- planning ----
const P = (name, a) => PLAN.plan(name, a);
{ const r = P('make_image', { prompt: 'a red car', path: path.join(rw, 'car.png') }); ok('image into a write folder is planned', r.ok && r.kind === 'make' && r.what === 'image' && /car\.png$/.test(r.to), JSON.stringify(r)); }
{ const r = P('make_speech', { prompt: 'Hello there', path: path.join(rw, 'v.wav') }); ok('speech is planned', r.ok && r.what === 'speech'); }
{ const r = P('make_music', { prompt: 'calm', path: path.join(rw, 'm.mp3'), seconds: 9999 }); ok('music is planned with a capped length', r.ok && r.seconds === 30, JSON.stringify(r)); }
{ const r = P('make_music', { prompt: 'calm', path: path.join(rw, 'm2.wav'), seconds: 1 }); ok('music length has a floor', r.ok && r.seconds === 5); }
{ const r = P('make_3d', { image_url: IMG, path: path.join(rw, 'm.glb') }); ok('3D from a picture link is planned', r.ok && r.what === '3d' && r.image_url === IMG && r.prompt === ''); }
for (const [what, tool, a] of [
  ['a read-only folder', 'make_image', { prompt: 'x', path: path.join(ro, 'a.png') }],
  ['a folder never allowed', 'make_image', { prompt: 'x', path: path.join(home, 'elsewhere', 'a.png') }],
  ['a Windows system folder', 'make_image', { prompt: 'x', path: 'C:\\Windows\\a.png' }],
  ['a .ps1 script as an image', 'make_image', { prompt: 'x', path: path.join(rw, 'a.ps1') }],
  ['a .bat as speech', 'make_speech', { prompt: 'x', path: path.join(rw, 'a.bat') }],
  ['an .exe as music', 'make_music', { prompt: 'x', path: path.join(rw, 'a.exe') }],
  ['a png as 3D', 'make_3d', { image_url: IMG, path: path.join(rw, 'a.png') }],
  ['a double extension trick', 'make_image', { prompt: 'x', path: path.join(rw, 'a.png.exe') }],
  ['no extension', 'make_image', { prompt: 'x', path: path.join(rw, 'a') }],
  ['no path', 'make_image', { prompt: 'x' }],
  ['an empty prompt', 'make_image', { prompt: '  ', path: path.join(rw, 'e.png') }],
  ['a missing prompt', 'make_music', { path: path.join(rw, 'e.wav') }],
  ['a huge prompt', 'make_image', { prompt: 'x'.repeat(1001), path: path.join(rw, 'h.png') }],
  ['a non-string prompt', 'make_image', { prompt: { a: 1 }, path: path.join(rw, 'o.png') }],
  ['3D with no picture link', 'make_3d', { path: path.join(rw, 'n.glb') }],
  ['3D from a foreign link', 'make_3d', { image_url: 'https://evil.example/p.png', path: path.join(rw, 'f.glb') }],
  ['3D from an http link', 'make_3d', { image_url: 'http://api.free.ai/p.png', path: path.join(rw, 'f.glb') }],
  ['3D from a look-alike host', 'make_3d', { image_url: 'https://free.ai.evil.com/p.png', path: path.join(rw, 'f.glb') }],
  ['3D from a local path', 'make_3d', { image_url: path.join(rw, 'p.png'), path: path.join(rw, 'f.glb') }],
  ['a path with a null byte', 'make_image', { prompt: 'x', path: path.join(rw, 'a\0.png') }],
  ['a key file name', 'make_image', { prompt: 'x', path: path.join(rw, '.env.png') }],
]) { const r = P(tool, a); ok('refused: ' + what, r.ok === false && typeof r.say === 'string' && r.say.length > 0, JSON.stringify(r)); }
{ fs.writeFileSync(path.join(rw, 'taken.png'), 'old'); const r = P('make_image', { prompt: 'x', path: path.join(rw, 'taken.png') }); ok('refused: it would overwrite an existing file', r.ok === false && /already exists/.test(r.say)); ok('the old file is untouched', fs.readFileSync(path.join(rw, 'taken.png'), 'utf8') === 'old'); }
{ const sub = path.join(rw, 'new', 'deep'); const r = P('make_image', { prompt: 'x', path: path.join(sub, 'a.png') }); ok('a new sub-folder inside the write folder is fine', r.ok === true); }
{ fs.mkdirSync(path.join(rw, 'link-target-outside'), { recursive: true }); const r = P('make_image', { prompt: 'x', path: path.join(rw, '..', 'ro', 'a.png') }); ok('a .. trick into the read-only folder is refused', r.ok === false); }

// ---- the runner ----
const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => Buffer.alloc(0), headers: { get: () => null } });
const FILE = (buf, len) => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), headers: { get: h => /content-length/i.test(h) ? String(len == null ? buf.length : len) : null } });
function rig(cloudFn, files = {}, o = {}) {
  const r = { calls: [], clock: 0, slept: 0 };
  const fetchFn = async (url, init = {}) => {
    r.calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, auth: (init.headers || {}).Authorization, redirect: init.redirect });
    if (/pholamaMedia/.test(String(url))) return cloudFn(init.body ? JSON.parse(init.body) : {}, r);
    const f = files[String(url)]; if (f instanceof Error) throw f; return f || J(404, {});
  };
  r.m = MEDIA.create({ fetchFn, getToken: () => o.token === undefined ? 'LOGIN-TOKEN' : o.token, url: 'http://x/pholamaMedia', now: () => r.clock, sleep: async ms => { r.clock += ms; r.slept += ms; }, signal: o.signal, onCredits: o.onCredits });
  return r;
}
const plan = (what, name, extra = {}) => ({ kind: 'make', what, to: path.join(rw, name), prompt: 'a thing', ...extra });
const plainOnly = t => !/free\.ai|flux|kokoro|triposr|ace-step|qwen|HTTP \d|gpu_busy|LOGIN-TOKEN|SECRET|pholamaMedia/i.test(String(t));

{ const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(REALPNG) }); const out = await r.m.execute(plan('image', 'one.png'));
  ok('image: saved a REAL png file', out.ok && fs.existsSync(path.join(rw, 'one.png')) && fs.readFileSync(path.join(rw, 'one.png')).equals(REALPNG), JSON.stringify(out));
  ok('image: the result tells the agent where it is and gives the picture link for 3D', /Saved image/.test(out.text) && out.text.includes(GOODURL));
  ok('image: the login goes to the cloud, never into the saved text', r.calls[0].auth === 'Bearer LOGIN-TOKEN' && !out.text.includes('LOGIN-TOKEN'));
  ok('the download refuses redirects', r.calls[1].redirect === 'error'); }
{ const u = 'https://api.free.ai/static/outputs/s.wav'; const r = rig(() => J(200, { url: u }), { [u]: FILE(REALWAV) }); const out = await r.m.execute(plan('speech', 'v.wav'));
  ok('speech: saved a REAL wav file', out.ok && fs.readFileSync(path.join(rw, 'v.wav')).equals(REALWAV)); ok('speech result has no picture link', !/make_3d/.test(out.text)); }
// no overwrite even if the file appears between planning and saving
{ fs.writeFileSync(path.join(rw, 'race.png'), 'mine'); const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(REALPNG) }); const out = await r.m.execute(plan('image', 'race.png'));
  ok('a file that appeared meanwhile is never overwritten', out.ok === false && out.code === 'exists' && fs.readFileSync(path.join(rw, 'race.png'), 'utf8') === 'mine'); }

// type checks
for (const [what, name, buf, label] of [['image', 't1.png', Buffer.from('<html>not a picture</html>'), 'html as a png'], ['image', 't2.png', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'), 'an .exe as a png'], ['speech', 't3.wav', REALPNG, 'a png as a wav'], ['music', 't4.wav', Buffer.from('#!/bin/sh\nrm -rf /\n\n\n'), 'a script as music'], ['3d', 't5.glb', REALPNG, 'a png as a glb'], ['image', 't6.png', Buffer.alloc(5), 'a tiny junk file']]) {
  const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(buf) }); const out = await r.m.execute(plan(what, name, what === '3d' ? { image_url: IMG } : {}));
  ok('wrong content refused and nothing saved: ' + label, out.ok === false && !fs.existsSync(path.join(rw, name)) && plainOnly(out.text), JSON.stringify(out)); }
ok('a real glb header passes', MEDIA.looksLike('3d', 'x.glb', Buffer.concat([Buffer.from('glTF'), Buffer.alloc(20)])));
ok('a real obj passes', MEDIA.looksLike('3d', 'x.obj', Buffer.from('# Blender OBJ file\nv 0 0 0\n')));
ok('a real mp3 passes (ID3 and frame sync)', MEDIA.looksLike('music', 'x.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])) && MEDIA.looksLike('music', 'x.mp3', Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(20)])));
ok('a wav claiming to be an mp3 is refused', !MEDIA.looksLike('music', 'x.mp3', REALWAV));

// size caps
{ const big = Buffer.concat([REALPNG.subarray(0, 16), Buffer.alloc(16e6)]); const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(big) }); const out = await r.m.execute(plan('image', 'big1.png'));
  ok('a result over the size cap is not saved', out.ok === false && out.code === 'big' && !fs.existsSync(path.join(rw, 'big1.png'))); }
{ const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(REALPNG, 99e6) }); const out = await r.m.execute(plan('image', 'big2.png'));
  ok('a size announced over the cap is refused before downloading it all', out.ok === false && out.code === 'big'); }

// hosts
for (const [label, link] of [['a foreign host', 'https://evil.example/a.png'], ['a look-alike host', 'https://api.free.ai.evil.com/a.png'], ['plain http', 'http://api.free.ai/a.png'], ['a file address', 'file:///etc/passwd'], ['nothing', ''], ['a number', 5]]) {
  const r = rig(() => J(200, { url: link }), {}); const out = await r.m.execute(plan('image', 'h.png'));
  ok('the cloud pointing at ' + label + ' downloads nothing', out.ok === false && r.calls.length === 1 && !fs.existsSync(path.join(rw, 'h.png')), JSON.stringify(r.calls.map(c => c.url))); }

// cloud errors are plain
for (const [label, resp, code] of [['not signed in', J(401, { code: 'login', error: 'Log in to use Agent Max.' }), 'login'], ['out of credits', J(429, { code: 'limit-month', error: 'Not enough credits (3 left)' }), 'limit'], ['generator busy', J(503, { code: 'busy' }), 'busy'], ['server error', J(500, { code: 'x', error: 'Deno stack trace at line 5' }), 'failed'], ['not json', { ok: false, status: 502, json: async () => { throw new Error('bad'); } }, 'failed']]) {
  const r = rig(() => resp); const out = await r.m.execute(plan('image', 'c.png'));
  ok('cloud says ' + label + ': plain words, no details', out.ok === false && out.code === code && plainOnly(out.text) && !/stack|Deno|line 5|Agent Max/.test(out.text), JSON.stringify(out)); }
{ const r = rig(() => J(200, {}), {}, { token: '' }); const out = await r.m.execute(plan('image', 'nl.png')); ok('no login: asks to sign in and calls nothing', out.code === 'login' && r.calls.length === 0); }
{ const r = rig(() => { throw new Error('socket hang up to https://secret.internal:9000'); }); const out = await r.m.execute(plan('image', 'nw.png')); ok('a network failure is plain and leaks no address', out.code === 'network' && plainOnly(out.text) && !/secret\.internal/.test(out.text)); }
{ let seen; const r = rig(() => J(200, { url: GOODURL, credits_left: 1234 }), { [GOODURL]: FILE(REALPNG) }, { onCredits: c => { seen = c; } }); await r.m.execute(plan('image', 'cr.png')); ok('the credits left are passed on to the usage display', seen && seen.left === 1234); }
{ const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(REALPNG) }); for (const bad of [null, undefined, {}, { kind: 'edit' }, { kind: 'make', what: 'video', to: path.join(rw, 'v.mp4') }, { kind: 'make', what: 'constructor', to: path.join(rw, 'c.png') }]) { const out = await r.m.execute(bad); ok('a bad plan is refused: ' + JSON.stringify(bad), out.ok === false); } ok('and nothing was called', r.calls.length === 0); }

// ---- queued: music and 3D ----
const JOB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', MUSIC = 'https://api.free.ai/static/outputs/m.wav', GLB = 'https://api.free.ai/static/outputs/m.glb';
const queued = (answers) => { let i = 0; return (b, r) => { if (b.action === 'start') return J(202, { queued: true, job: JOB, token: 'tok', kind: b.kind }); if (b.gaveUp) return J(200, { done: true, failed: true, code: 'timeout' }); const a = answers[Math.min(i++, answers.length - 1)]; return J(200, a); }; };
{ const r = rig(queued([{ done: false }, { done: false }, { done: true, url: MUSIC }]), { [MUSIC]: FILE(REALWAV) }); const out = await r.m.execute(plan('music', 'song.wav', { seconds: 12 }));
  ok('music: waits through the queue, then saves the real file', out.ok && fs.readFileSync(path.join(rw, 'song.wav')).equals(REALWAV), JSON.stringify(out));
  ok('music: polls with the signed token, not the login-only', r.calls.filter(c => c.body && c.body.action === 'poll').every(c => c.body.token === 'tok' && c.body.job === JOB));
  ok('music: 3 polls, ~4 seconds apart, nobody hammered the shared queue', r.calls.filter(c => c.body && c.body.action === 'poll').length === 3 && r.slept === 12000, r.slept);
  ok('music: no give-up was sent for a job that worked', !r.calls.some(c => c.body && c.body.gaveUp)); }
{ const r = rig(queued([{ done: false }]), {}); const out = await r.m.execute(plan('music', 'slow.wav'));
  ok('music: a queue that never moves stops at the 4-minute limit', out.ok === false && out.code === 'timeout' && r.clock >= 4 * 60e3 && r.clock < 4 * 60e3 + 10e3, r.clock);
  ok('music: on timeout the cloud is told to give up (that is what refunds)', r.calls.filter(c => c.body && c.body.gaveUp === true).length === 1);
  ok('music: nothing was saved and the message says not charged', !fs.existsSync(path.join(rw, 'slow.wav')) && /not charged/i.test(out.text) && plainOnly(out.text)); }
{ const r = rig(queued([{ done: false }]), {}); const out = await r.m.execute(plan('3d', 'slow.glb', { image_url: IMG, prompt: '' })); ok('3D: its limit is 6 minutes', out.code === 'timeout' && r.clock >= 6 * 60e3 && r.clock < 6 * 60e3 + 10e3, r.clock); }
{ const r = rig(queued([{ done: true, failed: true, code: 'failed' }]), {}); const out = await r.m.execute(plan('music', 'f.wav')); ok('a job that fails is reported plainly, not charged', out.ok === false && out.code === 'failed' && /not charged/i.test(out.text) && !r.calls.some(c => c.body && c.body.gaveUp)); }
{ const r = rig(queued([{ done: true, failed: true, code: 'timeout' }]), {}); const out = await r.m.execute(plan('music', 'f2.wav')); ok('a cloud-side timeout is reported as a timeout', out.code === 'timeout'); }
{ const r = rig(queued([{ done: true, url: GLB }]), { [GLB]: FILE(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40)])) }); const out = await r.m.execute(plan('3d', 'ok.glb', { image_url: IMG, prompt: '' }));
  ok('3D: saves the model', out.ok && fs.existsSync(path.join(rw, 'ok.glb')) && r.calls[0].body.image_url === IMG && r.calls[0].body.kind === '3d'); }
// Stop
{ const ac = new AbortController(); let polls = 0; const r = rig((b) => { if (b.action === 'start') return J(202, { queued: true, job: JOB, token: 'tok' }); if (b.gaveUp) return J(200, { done: true, failed: true, code: 'timeout' }); if (++polls === 2) ac.abort(); return J(200, { done: false }); }, {}, { signal: ac.signal });
  const out = await r.m.execute(plan('music', 'stopme.wav')); ok('Stop while waiting: ends at once with "Stopped"', out.ok === false && out.code === 'stopped' && /Stopped/.test(out.text) && polls === 2, JSON.stringify([out, polls]));
  ok('Stop while waiting: the cloud is told to give up (refund)', r.calls.some(c => c.body && c.body.gaveUp === true)); }
{ const ac = new AbortController(); ac.abort(); const r = rig(() => J(200, { url: GOODURL }), { [GOODURL]: FILE(REALPNG) }, { signal: ac.signal }); const out = await r.m.execute(plan('image', 'pre.png'));
  ok('Stop before starting: nothing asked, nothing spent', out.code === 'stopped' && r.calls.length === 0); }
{ const r = rig((b) => { if (b.action === 'start') return J(202, { queued: true, job: JOB, token: 'tok' }); return J(429, { code: 'limit-month' }); }); const out = await r.m.execute(plan('music', 'pl.wav')); ok('an error while waiting ends it plainly', out.ok === false && plainOnly(out.text)); }

// ---- the whole loop: the agent calls make_image, then make_3d with the link, through the real tool map ----
{ const API = require('../server/codebase-api'), budget = require('../server/codebase-budget');
  const r = rig((b) => b.action === 'start' && b.kind === 'image' ? J(200, { url: GOODURL }) : b.action === 'start' ? J(202, { queued: true, job: JOB, token: 't' }) : J(200, { done: true, url: GLB }), { [GOODURL]: FILE(REALPNG), [GLB]: FILE(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40)])) });
  const api = API.create({ grants, budget, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ reply: '<tool>{"name":"done","summary":"x"}</tool>' }) }), cloudUrl: 'http://cloud.test/x', media: r.m, win: { execute: async () => ({ ok: false, text: 'the PC runner must NOT be used for generators' }) }, github: { execute: async () => ({ ok: false, text: 'no' }) } });
  const a = await api.tools.make_image({ prompt: 'a toy car', path: path.join(rw, 'toy.png') });
  ok('through the real tool map: make_image saves a file', /^Saved image/.test(a) && fs.existsSync(path.join(rw, 'toy.png')), a);
  const link = (a.match(/https:\/\/[^\s]+/) || [])[0];
  const b = await api.tools.make_3d({ image_url: link, path: path.join(rw, 'toy.glb') });
  ok('through the real tool map: make_3d takes the link the picture gave', /^Saved 3d/.test(b) && fs.existsSync(path.join(rw, 'toy.glb')), b);
  const c = await api.tools.make_image({ prompt: 'x', path: path.join(ro, 'no.png') });
  ok('through the real tool map: a read-only folder is refused BEFORE any cloud call', /^REFUSED/.test(c) && !r.calls.some(x => x.body && x.body.prompt === 'x'), c);
  const d = await api.tools.make_music({ prompt: 'x', path: path.join(rw, 'evil.exe') });
  ok('through the real tool map: an .exe is refused', /^REFUSED/.test(d)); }

console.log(bad ? 'FAILURES: ' + bad + ' (' + n + ' checks)' : 'ALL PASSED (' + n + ' checks)'); process.exit(bad ? 1 : 0);
})();
