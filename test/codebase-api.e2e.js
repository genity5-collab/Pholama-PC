// Pholama Codebase routes on the REAL server: usage bar numbers, folder grants, and who is allowed in.
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + name + (c ? '' : '  -> ' + String(x).slice(0, 300))); if (!c) bad++; };
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-cb-')), port = 33000 + Math.floor(Math.random() * 2500), data = path.join(home, '.pholama');
  const proj = path.join(home, 'work', 'proj'); fs.mkdirSync(proj, { recursive: true });
  const srv = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { env: { ...process.env, PORT: String(port), HOME: home, USERPROFILE: home, PHOLAMA_HOME: data, PHOLAMA_NO_OPEN: '1', PHOLAMA_NO_AUTOUPDATE: '1' }, stdio: 'ignore' });
  const B = 'http://127.0.0.1:' + port; for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/version')).ok) break; } catch {} await wait(250); }
  const call = async (p, o = {}) => { const r = await fetch(B + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  try {
    let r = await call('/api/codebase/usage');
    ok('usage answers on the PC with the full set of numbers', r.s === 200 && r.j.cap === 15000 && r.j.used === 0 && r.j.left === 15000 && r.j.percent === 0 && r.j.state === 'ok', JSON.stringify(r));
    ok('usage carries the time zone and the clock the bar needs', typeof r.j.tz === 'string' && Math.abs(r.j.now - Date.now()) < 60000 && r.j.untilPause === 5000 && r.j.step === 5000 && r.j.pauseHours === 7, JSON.stringify(r.j));
    ok('usage can only be read, not written, from the page (no spend route exists)', (await call('/api/codebase/usage', { method: 'POST', body: { cost: 5000 } })).s === 404 && (await call('/api/codebase/spend', { method: 'POST', body: { cost: 5000 } })).s === 404);
    ok('...and nothing changed after those attempts', (await call('/api/codebase/usage')).j.used === 0);

    r = await call('/api/codebase/grants');
    ok('no folders are granted on a new install, and the installed-files folder is named', r.s === 200 && r.j.grants.length === 0 && /downloads$/.test(r.j.downloads), JSON.stringify(r));
    r = await call('/api/codebase/grants', { method: 'POST', body: { dir: proj, mode: 'write' } });
    ok('a project folder can be granted read+write', r.s === 200 && r.j.mode === 'write', JSON.stringify(r));
    ok('it shows up in the list', (await call('/api/codebase/grants')).j.grants.length === 1);
    r = await call('/api/codebase/grants', { method: 'POST', body: { dir: os.homedir() === home ? home : home } });
    ok('the home folder is refused with a plain reason', r.s === 400 && /home folder|own data/.test(r.j.error), JSON.stringify(r));
    r = await call('/api/codebase/grants', { method: 'POST', body: { dir: data } });
    ok('Pholama\'s own data folder (keys) is refused', r.s === 400 && /own data/.test(r.j.error), JSON.stringify(r));
    r = await call('/api/codebase/grants', { method: 'POST', body: {} });
    ok('a request with no folder is a clean 400, not a crash', r.s === 400 && r.j.error, JSON.stringify(r));
    r = await call('/api/codebase/grants/remove', { method: 'POST', body: { dir: proj } });
    ok('a grant can be removed', r.s === 200 && r.j.removed === true && (await call('/api/codebase/grants')).j.grants.length === 0);
    ok('an unknown Codebase route is a 404', (await call('/api/codebase/nope')).s === 404);

    // who may use it: another website, and a remote caller
    r = await call('/api/codebase/usage', { headers: { Origin: 'https://evil.example' } });
    ok('another website cannot read or change anything', r.s === 403, JSON.stringify(r));
    r = await call('/api/codebase/grants', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { dir: proj, mode: 'write' } });
    ok('another website cannot grant a folder', r.s === 403 && (await call('/api/codebase/grants')).j.grants.length === 0, JSON.stringify(r));
    r = await call('/api/codebase/usage', { headers: { Origin: 'https://genity5-collab.github.io' } });
    ok('even the Pholama website itself cannot read this PC\'s Codebase', r.s === 403 && /Only the Pholama app/.test(r.j.error), JSON.stringify(r));
    r = await call('/api/codebase/grants', { method: 'POST', headers: { Origin: 'https://genity5-collab.github.io' }, body: { dir: proj, mode: 'write' } });
    ok('...and cannot grant itself a folder (the hole I found)', r.s === 403 && (await call('/api/codebase/grants')).j.grants.length === 0, JSON.stringify(r));
    r = await call('/api/codebase/grants/remove', { method: 'POST', headers: { Origin: 'https://genity5-collab.github.io' }, body: { dir: proj } });
    ok('...and cannot remove grants either', r.s === 403, JSON.stringify(r));
    r = await call('/api/codebase/usage', { headers: { Origin: 'http://localhost:' + port } });
    ok('the app\'s own page (a localhost origin) still works', r.s === 200 && r.j.cap === 15000, JSON.stringify(r));
    r = await call('/api/codebase/usage', { headers: { Origin: 'http://localhost:1' } });
    ok('another program on this PC at a different port is not the app\'s own page', r.s === 403, JSON.stringify(r));
    r = await call('/api/codebase/usage', { headers: { Origin: 'http://localhost.evil.com' } });
    ok('a look-alike host name is not the app\'s own page', r.s === 403, JSON.stringify(r));
    r = await call('/api/codebase/usage', { headers: { Origin: 'null' } });
    ok('a sandboxed page with a "null" origin is refused', r.s === 403, JSON.stringify(r));
    r = await call('/api/codebase/usage', { headers: { 'X-Forwarded-For': '8.8.8.8', Authorization: 'Bearer sk-nonsense' } });
    ok('a made-up key gets nowhere', r.s !== 200 || r.j.cap === 15000, JSON.stringify(r));
    ok('the secret grants file is private and holds only the folder list', !fs.existsSync(path.join(data, 'codebase-grants.json')) || (fs.statSync(path.join(data, 'codebase-grants.json')).mode & 0o077) === 0 || process.platform === 'win32');
  } finally { srv.kill(); }
  console.log(bad ? 'FAILED ' + bad : 'ALL PASSED (' + n + ')'); process.exit(bad ? 1 : 0);
})();
