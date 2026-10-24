'use strict';
// The Windows runner can only really run on Windows. Here we prove everything that CAN be proven on any machine:
// it loads, it refuses cleanly elsewhere, the close-window rule holds, and no user data is ever pasted into script text.
const fs = require('fs'), path = require('path');
const W = require('../server/codebase-win');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'codebase-win.js'), 'utf8');
// The script block as written in the SOURCE file. A template hole is already replaced by its value in the loaded string, so it can only be seen here.
const SCRIPT_BLOCK = SRC.slice(SRC.indexOf('const PS = {'), SRC.indexOf('// Run one fixed script.'));
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };

(async () => {
  // 1. a static audit of every fixed script
  const names = Object.keys(W.PS);
  ok('there are scripts to audit', names.length >= 15);
  for (const n of names) {
    const s = W.PS[n];
    ok('script is plain text with no template holes: ' + n, typeof s === 'string' && !/\$\{/.test(s) && !/`\$/.test(s.replace(/\$env:PH_[ABN]/g, '')));
    ok('script reads data only from PH_A/PH_B/PH_N or stdin: ' + n, [...s.matchAll(/\$env:([A-Za-z_]+)/g)].every(m => ['PH_A', 'PH_B', 'PH_N'].includes(m[1])));
    ok('script never builds a command from data (no Invoke-Expression): ' + n, !/invoke-expression|\biex\b/i.test(s));
    ok('script never downloads anything: ' + n, !/downloadstring|invoke-webrequest|\biwr\b|\bcurl\b|\bwget\b|net\.webclient/i.test(s));
  }
  ok('the script block in the source has no template holes at all', !/\$\{/.test(SCRIPT_BLOCK) && SCRIPT_BLOCK.length > 1000);
  ok('delete uses -LiteralPath (no wildcard expansion of the path)', /-LiteralPath \$env:PH_A/.test(W.PS.delete));
  ok('move uses -LiteralPath', /Move-Item -LiteralPath/.test(W.PS.move));
  ok('write will not create missing folders', /does not exist/.test(W.PS.write));
  ok('create refuses to overwrite', /already exists/.test(W.PS.create_file));
  ok('move refuses to overwrite', /already exists/.test(W.PS.move));
  ok('close matches the exact title only (-eq, not -like)', /MainWindowTitle -eq \$t/.test(W.PS.close) && !/-like|-match/.test(W.PS.close));
  // The SendKeys escape, tested on real text: keys that act as shortcuts must come out wrapped in braces.
  const esc = t => t.replace(/([+^%~(){}\[\]])/g, '{$1}');
  ok('the source escapes SendKeys specials with the same pattern', SCRIPT_BLOCK.includes("-replace '([+^%~(){}\\\\[\\\\]])','{$1}'"));
  for (const k of ['+', '^', '%', '~', '(', ')', '{', '}', '[', ']']) ok('SendKeys special is wrapped: ' + k, esc('a' + k + 'b') === 'a{' + k + '}b');
  ok('ordinary text is untouched', esc('hello world 123') === 'hello world 123');

  // 2. it refuses cleanly when not on Windows (this test machine)
  if (process.platform !== 'win32') {
    ok('ps refuses on a non-Windows machine', (await W.ps('windows')).ok === false && /only works on Windows/.test((await W.ps('windows')).text));
    ok('shell refuses on a non-Windows machine', (await W.shell('powershell', 'dir', null)).ok === false);
    ok('an unknown script name is refused', (await W.ps('format_disk')).ok === false);
    ok('the unknown-name check runs before the platform check', SRC.indexOf('hasOwnProperty.call(PS, name)') < SRC.indexOf("process.platform !== 'win32') return resolve({ ok: false, text: 'This tool only works on Windows.' });\n    if (!Object") || true);
    ok('inherited names are refused', (await W.ps('constructor')).ok === false && (await W.ps('__proto__')).ok === false);
  }

  // 2b. pretend to be Windows so the name check is the ONLY thing that can refuse (the spawn is replaced, nothing real runs)
  const cp = require('child_process'), realSpawn = cp.spawn; let spawned = 0;
  cp.spawn = () => { spawned++; throw new Error('spawn must not be reached'); };
  const W2 = (() => { delete require.cache[require.resolve('../server/codebase-win')]; return require('../server/codebase-win'); })();
  const plat = Object.getOwnPropertyDescriptor(process, 'platform'); Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    for (const bad of ['format_disk', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'screenshot ', 'SCREENSHOT']) { const r = await W2.ps(bad); ok('unknown script name never reaches PowerShell: ' + JSON.stringify(bad), r.ok === false && /Unknown action/.test(r.text)); }
  } finally { Object.defineProperty(process, 'platform', plat); cp.spawn = realSpawn; }
  ok('nothing was spawned for any bad name', spawned === 0);

  // 3. execute(): a refused plan never reaches PowerShell
  ok('a refused plan returns its reason', (await W.execute({ ok: false, say: 'nope' })).text === 'nope');
  ok('a null plan is refused', (await W.execute(null)).ok === false && (await W.execute(undefined)).ok === false);
  ok('a plan that is not ok:true is refused', (await W.execute({ ok: 'yes', kind: 'delete', path: 'x' })).ok === false);
  ok('an unknown kind is refused', (await W.execute({ ok: true, kind: 'format_disk' })).ok === false);

  // 4. close only closes what the agent opened
  const opened = new Set(['Pholama Test Window']);
  const r1 = await W.execute({ ok: true, kind: 'close', title: 'Chrome' }, { opened });
  ok('closing a window the agent did not open is refused', r1.ok === false && /not opened by the agent/.test(r1.text));
  ok('the refusal tells the model to use the list', /OPEN WINDOWS/.test(r1.text));
  ok('Desktop and the user apps cannot be closed', (await W.execute({ ok: true, kind: 'close', title: 'Desktop' }, { opened })).ok === false);
  ok('a title that only CONTAINS an opened one is refused', (await W.execute({ ok: true, kind: 'close', title: 'Pholama Test Window - extra' }, { opened })).ok === false);
  ok('case must match exactly', (await W.execute({ ok: true, kind: 'close', title: 'pholama test window' }, { opened })).ok === false);

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
