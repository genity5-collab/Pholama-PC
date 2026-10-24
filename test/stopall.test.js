'use strict';
// Stopping every Pholama process before removal, without ever touching anything that is not Pholama's.
const fs = require('fs'), os = require('os'), path = require('path');
const S = require('../server/stopall');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
const APP = path.join(tmp, 'Pholama'), DATA = path.join(tmp, '.pholama'), ROOTS = [APP, DATA];

const P = (pid, name, exe) => ({ pid, name, exe });
const table = [
  P(100, 'llama-server', path.join(DATA, 'llama', 'llama-server')),       // the AI engine: Pholama's
  P(101, 'node', path.join(DATA, 'node', 'node')),                         // private node: Pholama's
  P(102, 'node', path.join(APP, 'node_modules', 'x', 'node')),             // inside the app: Pholama's
  P(200, 'node', '/usr/bin/node'),                                         // the USER'S own node
  P(201, 'chrome', '/usr/bin/chrome'),
  P(202, 'node', path.join(tmp, 'Pholama-backup', 'node')),                // lookalike folder
  P(203, 'node', path.join(tmp, 'NotPholama', 'node')),                    // lookalike folder
  P(204, 'node', path.join(tmp, '.pholama2', 'node')),                     // lookalike folder
  P(205, 'llama-server', '/opt/someone-elses/llama-server'),               // another llama-server NOT in our folders
  P(300, 'node', path.join(DATA, 'node', 'node')),                         // will be "me"
];
const mk = (rows) => { const alive = new Set(rows.map(r => r.pid)); const killed = []; return { list: () => rows.filter(r => alive.has(r.pid)), kill: pid => { killed.push(pid); alive.delete(pid); return true; }, exists: pid => alive.has(pid), killed, alive }; };

(async () => {
  // 1. who counts as Pholama's
  let w = mk(table);
  let found = S.pholamaProcesses(ROOTS, { list: w.list, self: 300, pidFiles: [] }).map(p => p.pid).sort();
  ok('finds the engine, the private node and the app node', JSON.stringify(found) === JSON.stringify([100, 101, 102]));
  ok('never selects the user\'s own node', !found.includes(200));
  ok('never selects other apps', !found.includes(201));
  ok('lookalike folders are not Pholama: Pholama-backup', !found.includes(202));
  ok('lookalike folders are not Pholama: NotPholama', !found.includes(203));
  ok('lookalike folders are not Pholama: .pholama2', !found.includes(204));
  ok('another llama-server outside our folders is left alone', !found.includes(205));
  ok('never selects itself', !found.includes(300));
  ok('never selects its own parent', (() => { const t = [P(process.ppid, 'node', path.join(APP, 'node')), P(1, 'x', '')]; return S.pholamaProcesses(ROOTS, { list: () => t, self: 999 }).length === 0; })());

  // 2. pid files: a pid number alone is never enough
  const pf = path.join(tmp, 'server.pid'); fs.writeFileSync(pf, '200');
  ok('a pid file pointing at the user\'s node does not select it', !S.pholamaProcesses(ROOTS, { list: w.list, self: 300, pidFiles: [pf] }).some(p => p.pid === 200));
  fs.writeFileSync(pf, '205');
  ok('a pid file pointing at an engine selects it (reused pid check passes by name)', S.pholamaProcesses(ROOTS, { list: w.list, self: 300, pidFiles: [pf] }).some(p => p.pid === 205));
  fs.writeFileSync(pf, '201');
  ok('a pid file pointing at chrome does not select it', !S.pholamaProcesses(ROOTS, { list: w.list, self: 300, pidFiles: [pf] }).some(p => p.pid === 201));
  for (const bad of ['', 'abc', '-5', '0', '99999999', '1e9', '12 34']) { fs.writeFileSync(pf, bad); ok('junk pid file is harmless: ' + JSON.stringify(bad), (() => { try { return S.pholamaProcesses(ROOTS, { list: w.list, self: 300, pidFiles: [pf] }).every(p => [100, 101, 102].includes(p.pid)); } catch { return false; } })()); }
  ok('a missing pid file is harmless', S.pholamaProcesses(ROOTS, { list: w.list, self: 300, pidFiles: [path.join(tmp, 'nope.pid')] }).length === 3);

  // 3. stopAll kills exactly the right ones
  w = mk(table);
  let r = await S.stopAll(ROOTS, { list: w.list, kill: w.kill, self: 300, wait: async () => {}, pidFiles: [] });
  ok('stopAll stops the three Pholama processes', JSON.stringify(w.killed.sort()) === JSON.stringify([100, 101, 102]));
  ok('stopAll leaves every other process alone', [200, 201, 202, 203, 204, 205, 300].every(p => w.alive.has(p)));
  ok('stopAll reports them as stopped and none failed', r.stopped.length === 3 && r.failed.length === 0 && r.left.length === 0);

  // 4. a process that refuses to die is reported, not hidden
  w = mk(table); const stubborn = pid => { w.killed.push(pid); return pid === 100 ? true : (w.alive.delete(pid), true); };
  r = await S.stopAll(ROOTS, { list: w.list, kill: stubborn, self: 300, wait: async () => {}, tries: 3, pidFiles: [] });
  ok('a process that will not die is listed in failed and left', r.failed.some(p => p.pid === 100) && r.left.includes(100));
  ok('it retried the stubborn one more than once', w.killed.filter(p => p === 100).length >= 2);
  w = mk(table); r = await S.stopAll(ROOTS, { list: w.list, kill: () => false, self: 300, wait: async () => {}, tries: 2, pidFiles: [] });
  ok('when kill itself fails nothing is claimed as stopped', r.stopped.length === 0 && r.failed.length === 3);

  // 5. the polite step runs first and a failure in it does not stop the rest
  const order = []; w = mk(table);
  await S.stopAll(ROOTS, { list: w.list, kill: pid => (order.push('kill' + pid), w.alive.delete(pid), true), polite: async () => { order.push('polite'); throw new Error('server not answering'); }, self: 300, wait: async () => {}, pidFiles: [] });
  ok('polite shutdown is tried first', order[0] === 'polite');
  ok('a failing polite shutdown does not stop the force step', order.some(x => x.startsWith('kill')));

  // 6. nothing running
  r = await S.stopAll(ROOTS, { list: () => [], kill: () => { throw new Error('should not kill'); }, self: 300, wait: async () => {}, pidFiles: [] });
  ok('with nothing running it kills nothing and succeeds', r.stopped.length === 0 && r.failed.length === 0);
  r = await S.stopAll(ROOTS, { list: () => { throw new Error('ps broke'); }, kill: () => true, self: 300, wait: async () => {}, pidFiles: [] }).catch(e => ({ threw: true }));
  ok('if the process list cannot be read it does not crash the removal and kills nothing', !r.threw && r.stopped.length === 0);
  ok('and the result says the list was unreadable so the caller can warn', r.unreadable === true);
  ok('a readable list is not flagged unreadable', (await S.stopAll(ROOTS, { list: () => [], kill: () => true, self: 300, wait: async () => {}, pidFiles: [] })).unreadable === false);

  // 7. pid files are cleaned up
  const f1 = path.join(tmp, 'helper.pid'); fs.writeFileSync(f1, '100'); w = mk(table);
  await S.stopAll(ROOTS, { list: w.list, kill: w.kill, self: 300, wait: async () => {}, pidFiles: [f1] });
  ok('pid files are deleted after stopping', !fs.existsSync(f1));

  // 8. path logic
  ok('insideAny: inside', S.insideAny(path.join(APP, 'a', 'b'), ROOTS));
  ok('insideAny: the folder itself', S.insideAny(APP, ROOTS));
  ok('insideAny: a sibling with the same prefix is NOT inside', !S.insideAny(APP + '-backup/x', ROOTS) && !S.insideAny(APP + 'X/x', ROOTS));
  ok('insideAny: case does not fool it', S.insideAny(APP.toUpperCase() + '/x', ROOTS));
  ok('insideAny: .. cannot sneak out', !S.insideAny(path.join(APP, '..', 'other', 'x'), ROOTS));
  ok('insideAny: empty and null are never inside', !S.insideAny('', ROOTS) && !S.insideAny(null, ROOTS) && !S.insideAny(undefined, ROOTS));
  ok('insideAny: empty roots match nothing', !S.insideAny(APP, []) && !S.insideAny(APP, ['']));

  // 9. the process list parsers
  const lin = S.listProcesses('linux', () => '  1 init /sbin/init\n 100 llama-server /home/u/.pholama/llama/llama-server -m x\nbadline\n 200 node /usr/bin/node app.js\n');
  ok('ps output is parsed', lin.length === 3 && lin[1].pid === 100 && lin[1].exe === '/home/u/.pholama/llama/llama-server');
  const win = S.listProcesses('win32', () => '100|llama-server.exe|C:\\Users\\u\\.pholama\\llama\\llama-server.exe\r\n4|System|\r\nx|bad\r\n200|node.exe|C:\\Program Files\\nodejs\\node.exe\r\n');
  ok('Windows output is parsed', win.length === 3 && win[0].pid === 100 && win[0].exe.endsWith('llama-server.exe') && win[1].exe === '');
  ok('a failing list command gives an empty list, not a crash', S.listProcesses('linux', () => { throw new Error('x'); }).length === 0);

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASSED'} (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
