'use strict';
// Runs the REAL install.sh in a throwaway home with a stubbed curl, so no network and nothing real is touched.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const SH = path.join(__dirname, '..', 'install', 'install.sh');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
const w = (p, t = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };

// a fake "download": a tarball whose top folder is named like GitHub names it (the repo is Pholama-PC, so Pholama-PC-main)
function makeTar(name, files, top = 'Pholama-PC-main') {
  const src = path.join(root, 'src-' + name); fs.rmSync(src, { recursive: true, force: true });
  for (const f of files) w(path.join(src, top, f), 'v:' + name);
  const out = path.join(root, name + '.tgz'); cp.execFileSync('tar', ['-czf', out, '-C', src, top]); return out;
}
const FULL = ['server/cli.js', 'server/server.js', 'models.pc.json', 'start.sh', 'web/icon-512.png'];
const good = makeTar('good', FULL), noCli = makeTar('nocli', FULL.filter(f => f !== 'server/cli.js')), noModels = makeTar('nomodels', FULL.filter(f => f !== 'models.pc.json'));
const bad = path.join(root, 'bad.tgz'); fs.writeFileSync(bad, 'this is not a tarball');

function install(tarball, home, { curlFails = false } = {}) {
  const bin = path.join(root, 'bin-' + Math.random().toString(36).slice(2)); fs.mkdirSync(bin, { recursive: true });
  // curl stub: copies our tarball where the installer asks (-o), or fails
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\n${curlFails ? 'exit 22' : ''}\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\ncp "${tarball}" "$out"\n`, { mode: 0o755 });
  // node stub that does nothing (the real one would start a server at the end)
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\ncase "$*" in *"process.versions"*) echo 20;; esac\nexit 0\n`, { mode: 0o755 });
  const r = cp.spawnSync('bash', [SH], { env: { PATH: bin + ':/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 60 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const homeN = n => { const h = path.join(root, 'home-' + n); fs.mkdirSync(h, { recursive: true }); return h; };

// 1. a good download installs everything
let h = homeN(1), r = install(good, h);
ok('a good download installs (exit 0)', r.code === 0);
ok('the app files are there', FULL.every(f => fs.existsSync(path.join(h, 'Pholama', f))));
ok('the pholama and phollama commands are created and executable', ['pholama', 'phollama'].every(c => { try { fs.accessSync(path.join(h, '.local/bin', c), fs.constants.X_OK); return true; } catch { return false; } }));
ok('the command points at the installed cli.js', fs.readFileSync(path.join(h, '.local/bin/pholama'), 'utf8').includes(path.join(h, 'Pholama', 'server/cli.js')));
ok('the launcher entry is created', fs.existsSync(path.join(h, '.local/share/applications/pholama.desktop')));
ok('it says Installed', /Installed\./.test(r.out));

// 2. a reinstall removes stale files from the old version but keeps models/chats (they live in .pholama)
w(path.join(h, 'Pholama', 'old-file-from-v1.js')); w(path.join(h, 'Pholama', 'server/old-module.js')); w(path.join(h, '.pholama', 'models/keep.gguf'), 'MODEL'); w(path.join(h, '.pholama', 'state.json'), '{}');
r = install(good, h);
ok('reinstall succeeds', r.code === 0);
ok('stale files from the previous version are gone', !fs.existsSync(path.join(h, 'Pholama', 'old-file-from-v1.js')) && !fs.existsSync(path.join(h, 'Pholama', 'server/old-module.js')));
ok('the new files are there', FULL.every(f => fs.existsSync(path.join(h, 'Pholama', f))));
ok('models and chats in .pholama are untouched', fs.readFileSync(path.join(h, '.pholama/models/keep.gguf'), 'utf8') === 'MODEL' && fs.existsSync(path.join(h, '.pholama/state.json')));

// 3. broken downloads never damage an existing install
for (const [name, tarball, extra] of [['a download that is not a tarball', bad, {}], ['a tarball missing server/cli.js', noCli, {}], ['a tarball missing models.pc.json', noModels, {}], ['a failed download', good, { curlFails: true }]]) {
  h = homeN('b' + name.length); install(good, h); w(path.join(h, 'Pholama', 'my-marker.txt'), 'KEEP');
  const before = fs.readFileSync(path.join(h, 'Pholama', 'server/cli.js'), 'utf8');
  r = install(tarball, h, extra);
  ok(name + ': exits non-zero', r.code !== 0);
  ok(name + ': the existing install is untouched', fs.existsSync(path.join(h, 'Pholama', 'my-marker.txt')) && fs.readFileSync(path.join(h, 'Pholama', 'server/cli.js'), 'utf8') === before);
  ok(name + ': the user is told what happened and no success message is shown', /(Could not|damaged|incomplete)/.test(r.out) && !/Installed\./.test(r.out));
}
// 3b. the top folder's name must not matter (GitHub names it after the repo and branch, and the repo has been renamed before)
for (const top of ['Pholama-PC-main', 'Pholama-main', 'Something-Else-main', 'x']) {
  h = homeN('top-' + top); r = install(makeTar('top-' + top, FULL, top), h);
  ok('a download whose folder is called "' + top + '" installs', r.code === 0 && FULL.every(f => fs.existsSync(path.join(h, 'Pholama', f))) && /Installed\./.test(r.out), r.out.slice(-200));
}
// 3c. the exact failure that was reported: the program is not in the folder the old script looked in
{ const src = path.join(root, 'src-nested'); fs.rmSync(src, { recursive: true, force: true }); for (const f of FULL) w(path.join(src, 'Pholama-PC-main', f), 'nested');
  const out = path.join(root, 'nested.tgz'); cp.execFileSync('tar', ['-czf', out, '-C', src, 'Pholama-PC-main']);
  h = homeN('nested'); r = install(out, h); ok('the real GitHub layout (Pholama-PC-main) installs, not "incomplete"', r.code === 0 && !/incomplete/.test(r.out)); }
// 3d. a download with no program anywhere is still refused, and an existing install survives
{ const src = path.join(root, 'src-empty'); fs.rmSync(src, { recursive: true, force: true }); w(path.join(src, 'Pholama-PC-main', 'README.md'), 'only a readme');
  const out = path.join(root, 'empty.tgz'); cp.execFileSync('tar', ['-czf', out, '-C', src, 'Pholama-PC-main']);
  h = homeN('emptydl'); install(good, h); w(path.join(h, 'Pholama', 'my-marker.txt'), 'KEEP'); r = install(out, h);
  ok('a download with no program in it is refused and nothing is changed', r.code !== 0 && /incomplete/.test(r.out) && fs.existsSync(path.join(h, 'Pholama', 'my-marker.txt'))); }
// 3e. older unsuccessful attempts are cleaned up
{ h = homeN('half'); w(path.join(h, 'Pholama', 'junk-from-failed-run.tmp')); w(path.join(h, 'Pholama', 'web/half.js')); w(path.join(h, 'Pholama', 'node_modules/keep/x.js'), 'KEEP');
  r = install(good, h);
  ok('a half-finished install (no cli.js) is cleaned, then a fresh install succeeds', r.code === 0 && !fs.existsSync(path.join(h, 'Pholama', 'junk-from-failed-run.tmp')) && !fs.existsSync(path.join(h, 'Pholama', 'web/half.js')) && FULL.every(f => fs.existsSync(path.join(h, 'Pholama', f))));
  ok('it tells the user it cleaned up', /Cleaned up leftover files/.test(r.out));
  ok('node_modules is kept while cleaning', fs.readFileSync(path.join(h, 'Pholama', 'node_modules/keep/x.js'), 'utf8') === 'KEEP'); }
{ h = homeN('half2'); w(path.join(h, 'Pholama', 'leftover.tmp')); w(path.join(h, '.pholama', 'models/keep.gguf'), 'MODEL'); install(noCli, h);
  ok('cleaning a half-finished install never touches models or chats', fs.readFileSync(path.join(h, '.pholama/models/keep.gguf'), 'utf8') === 'MODEL'); }
{ h = homeN('workinginstall'); install(good, h); w(path.join(h, 'Pholama', 'my-marker.txt'), 'KEEP'); install(noCli, h);
  ok('a WORKING install is never "cleaned" by the sweep (only a broken download fails, nothing is lost)', fs.existsSync(path.join(h, 'Pholama', 'my-marker.txt')) && fs.existsSync(path.join(h, 'Pholama', 'server/cli.js'))); }
{ h = homeN('quiet'); r = install(good, h); ok('a clean first install does not claim it cleaned anything', !/Cleaned up/.test(r.out)); }

// 4. a broken download on a FIRST install leaves nothing behind
h = homeN('fresh'); r = install(noCli, h);
ok('a broken first install creates no app folder', !fs.existsSync(path.join(h, 'Pholama')));
ok('a broken first install creates no command', !fs.existsSync(path.join(h, '.local/bin/pholama')));

// 5. the Windows script: static checks (it cannot run here)
const ps = fs.readFileSync(path.join(__dirname, '..', 'install', 'install.ps1'), 'utf8');
ok('windows: the download is wrapped in try/catch', /try \{\s*\n\s*Invoke-WebRequest \$zip[\s\S]*?\} catch/.test(ps));
ok('windows: it verifies the three key files before touching the old install', ps.indexOf("'server\\cli.js','server\\server.js','models.pc.json'") > 0 && ps.indexOf('The download was incomplete') < ps.indexOf('Copy-Item (Join-Path $src'));
ok('windows: the reinstall wipe of the old app runs only after the download checks pass', ps.indexOf('The download was incomplete') < ps.indexOf("Where-Object { $_.Name -notin @('node_modules') } | Remove-Item"));
ok('windows: it verifies the result after copying', /Install failed: \$f is missing/.test(ps));
ok('windows: node_modules is kept when cleaning', /-notin @\('node_modules'\)/.test(ps));
ok('windows: no Remove-Item line ever targets the .pholama data folder', !ps.split('\n').some(l => /Remove-Item/.test(l) && /\.pholama/.test(l)));
ok('windows: the old wrong folder name Pholama-main is gone', !/'Pholama-main'/.test(ps));
ok('windows: the unpacked folder is found by looking for server\\cli.js', /Get-ChildItem \$tmp -Directory[\s\S]{0,200}Test-Path \(Join-Path \$d\.FullName 'server\\cli\.js'\)/.test(ps));
ok('windows: the real name Pholama-PC-main is the fallback', /Pholama-PC-main/.test(ps));
ok('windows: old failed attempts are cleaned before anything starts', /function Clean-OldAttempts/.test(ps) && ps.indexOf('\nClean-OldAttempts') > 0 && ps.indexOf('\nClean-OldAttempts') < ps.indexOf('Downloading Pholama to'));
ok('windows: only leftovers of its own naming are removed from TEMP (exact names, not a wildcard)', /\^\(pholama_\[0-9a-f\]\{32\}\|nodex_\[0-9a-f\]\{32\}\|node_\[0-9a-f\]\{32\}\\\.zip\)\$/.test(ps));
ok('windows: leftovers newer than 10 minutes are kept (another window may be installing)', /AddMinutes\(-10\)/.test(ps) && /LastWriteTime -lt \$cut/.test(ps));
ok('windows: a half-finished install is cleaned only when server\\cli.js is missing', /Test-Path \$dir\) -and -not \(Test-Path \(Join-Path \$dir 'server\\cli\.js'\)\)/.test(ps));
ok('windows: the cleanup keeps node_modules and never names .pholama', /-ne 'node_modules'/.test(ps.split('function Clean-OldAttempts')[1].split('Clean-OldAttempts\n')[0]));
ok('windows: the cleanup is wrapped so a locked file can never stop the install', (ps.split('function Clean-OldAttempts')[1].split('\nClean-OldAttempts')[0].match(/try \{/g) || []).length >= 2);
ok('windows: the failure paths return instead of continuing', (ps.match(/\n\s*return\n/g) || []).length >= 3);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
