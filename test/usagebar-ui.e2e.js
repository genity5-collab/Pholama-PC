// The usage bar in REAL Chrome, served by the REAL server, in each state (ok / resting / locked) and when the data is bad.
const { spawn, spawnSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'); const wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0, n = 0; const ok = (name, c, x) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + name + (c ? '' : '  -> ' + String(x).slice(0, 300))); if (!c) bad++; };
(async () => {
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  if (spawnSync(chrome, ['--version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIPPED: Chrome is not installed here'); process.exit(0); }
  const root = path.join(__dirname, '..'), shots = process.env.SHOTS || '';
  const mk = (state) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-ub-')), data = path.join(home, '.pholama'); fs.mkdirSync(data, { recursive: true });
    const d = new Date(), month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (state) fs.writeFileSync(path.join(data, 'codebase-usage.json'), JSON.stringify({ v: 1, month, used: state.used, pauseUntil: state.pauseUntil || 0, pauses: 0 }));
    return { home, data };
  };
  const run = async (label, state) => {
    const { home, data } = mk(state), port = 38000 + Math.floor(Math.random() * 1500);
    const srv = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { env: { ...process.env, PORT: String(port), HOME: home, USERPROFILE: home, PHOLAMA_HOME: data, PHOLAMA_NO_OPEN: '1', PHOLAMA_NO_AUTOUPDATE: '1' }, stdio: 'ignore' });
    const B = 'http://127.0.0.1:' + port; for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/version')).ok) break; } catch {} await wait(250); }
    const shot = shots ? path.join(shots, label + '.png') : path.join(home, 'x.png');
    const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=900,420', '--virtual-time-budget=6000', '--screenshot=' + shot, '--dump-dom', B + '/'], { encoding: 'utf8', timeout: 60000, maxBuffer: 30 * 1024 * 1024 });
    srv.kill(); return { dom: r.stdout || '', shot };
  };
  const box = dom => (dom.match(/<div id="cbUsage">([\s\S]*?)<\/div><div id="studio"/) || dom.match(/<div id="cbUsage">([\s\S]{0,1500})/) || [])[1] || '';

  let r = await run('ok', { used: 3300 }), b = box(r.dom);
  ok('OK state: the bar is on the real page with "22% used" and a 22% fill', /22% used/.test(b) && /width:22%/.test(b) && !/ubar paused|ubar locked/.test(b), b.slice(0, 300));
  ok('OK state: heading, remaining credits and the next rest are written out', /Current month/.test(b) && /11,700 left/.test(b) && /rest after 1,700 more/.test(b), b);
  r = await run('resting', { used: 5200, pauseUntil: Date.now() + 3 * 3600 * 1000 }); b = box(r.dom);
  ok('RESTING state: amber class, 35% and the time it comes back', /ubar paused/.test(b) && /35% used/.test(b) && /Resting\. Back at/.test(b), b.slice(0, 300));
  r = await run('locked', { used: 15000 }); b = box(r.dom);
  ok('LOCKED state: red class, 100% and the reset date', /ubar locked/.test(b) && /100% used/.test(b) && /All 15,000 used\. Resets/.test(b), b.slice(0, 300));
  r = await run('expired-rest', { used: 5200, pauseUntil: Date.now() - 1000 }); b = box(r.dom);
  ok('A rest that already ended shows the normal bar again', /35% used/.test(b) && !/ubar paused/.test(b) && !/Resting/.test(b), b.slice(0, 300));
  r = await run('broken-file', null); fs.existsSync(r.shot);
  ok('A new install (no usage file yet) shows 0% used', /0% used/.test(box(r.dom)) && /15,000 left/.test(box(r.dom)), box(r.dom).slice(0, 300));
  ok('No state ever prints NaN, undefined or null on the page', ![].concat(r.dom).some(d => /<div id="cbUsage">[^]*?(NaN|undefined|null)[^]*?<div id="studio"/.test(d)));
  ok('a screenshot was produced for each state', !shots || ['ok', 'resting', 'locked'].every(s => fs.existsSync(path.join(shots, s + '.png')) && fs.statSync(path.join(shots, s + '.png')).size > 3000));
  console.log(bad ? 'FAILED ' + bad : 'ALL PASSED (' + n + ')'); process.exit(bad ? 1 : 0);
})();
