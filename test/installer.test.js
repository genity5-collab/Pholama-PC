'use strict';
// Runs the REAL install.sh in a throwaway home with a stubbed curl, so no network and nothing real is touched.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const SH = path.join(__dirname, '..', 'install', 'install.sh');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
const w = (p, t = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };

// a fake "download": a tarball with a Pholama-main folder
function makeTar(name, files) {
  const src = path.join(root, 'src-' + name); fs.rmSync(src, { recursive: true, force: true });
  for (const f of files) w(path.join(src, 'Pholama-main', f), 'v:' + name);
  const out = path.join(root, name + '.tgz'); cp.execFileSync('tar', ['-czf', out, '-C', src, 'Pholama-main']); return out;
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
// 4. a broken download on a FIRST install leaves nothing behind
h = homeN('fresh'); r = install(noCli, h);
ok('a broken first install creates no app folder', !fs.existsSync(path.join(h, 'Pholama')));
ok('a broken first install creates no command', !fs.existsSync(path.join(h, '.local/bin/pholama')));

// 5. the Windows script: static checks (it cannot run here)
const ps = fs.readFileSync(path.join(__dirname, '..', 'install', 'install.ps1'), 'utf8');
ok('windows: the download is wrapped in try/catch', /try \{\s*\n\s*Invoke-WebRequest \$zip[\s\S]*?\} catch/.test(ps));
ok('windows: it verifies the three key files before touching the old install', ps.indexOf("'server\\cli.js','server\\server.js','models.pc.json'") > 0 && ps.indexOf('The download was incomplete') < ps.indexOf('Copy-Item (Join-Path $src'));
ok('windows: stale files are removed only after the checks pass', ps.indexOf('The download was incomplete') < ps.indexOf('Remove-Item -Recurse -Force -ErrorAction SilentlyContinue'));
ok('windows: it verifies the result after copying', /Install failed: \$f is missing/.test(ps));
ok('windows: node_modules is kept when cleaning', /-notin @\('node_modules'\)/.test(ps));
ok('windows: no Remove-Item line ever targets the .pholama data folder', !ps.split('\n').some(l => /Remove-Item/.test(l) && /\.pholama/.test(l)));
ok('windows: the failure paths return instead of continuing', (ps.match(/\n\s*return\n/g) || []).length >= 3);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
process.exit(fail ? 1 : 0);
