'use strict';
// Stops EVERYTHING Pholama started on this PC before it is removed: the server, the AI engines, the helper engine, the update task's child.
// A process is only stopped when we can prove it is Pholama's: its pid is in a Pholama pid file AND it still looks like the program we started,
// or its program file lives inside a Pholama folder. A pid number alone is never enough (pids are reused by unrelated programs).
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const PID_FILES = ['server.pid', 'helper.pid', 'engine.pid', 'llama.pid'];
const WANT = /llama-server|llama\.cpp|node(?:\.exe)?|pholama/i;   // what a Pholama process can look like by name

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Every running process as { pid, name, exe }. Windows uses PowerShell/CIM, others use ps. Returns [] if it cannot tell.
function listProcesses(platform = process.platform, run = (c, a) => cp.execFileSync(c, a, { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })) {
  try {
    if (platform === 'win32') {
      const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.Name,$_.ExecutablePath }"]);
      return out.split(/\r?\n/).map(l => l.split('|')).filter(p => +p[0]).map(p => ({ pid: +p[0], name: p[1] || '', exe: p.slice(2).join('|') || '' }));
    }
    const out = run('ps', ['-eo', 'pid=,comm=,args=']);
    return out.split('\n').map(l => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], name: m[2], exe: m[3].split(' ')[0] }));
  } catch { return []; }
}

const norm = p => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const insideAny = (file, dirs) => { const f = norm(file); return dirs.some(d => { const x = norm(d); return x && (f === x || f.startsWith(x + path.sep) || f.startsWith(x + '/') || f.startsWith(x + '\\')); }); };

// Which processes belong to Pholama? roots = the folders Pholama owns (app folder, data folder).
function pholamaProcesses(roots, { list = listProcesses, self = process.pid, readPid = f => { try { return +fs.readFileSync(f, 'utf8').trim(); } catch { return 0; } }, pidFiles = [] } = {}) {
  let all = []; try { all = list() || []; } catch { all = []; }   // if processes cannot be listed, we simply see none (the caller is told the list was unreadable)
  const byPid = new Map(all.map(p => [p.pid, p])), found = new Map();
  for (const p of all) {
    if (p.pid === self || p.pid === process.ppid) continue;
    if (p.exe && insideAny(p.exe, roots) && WANT.test(p.name + ' ' + p.exe)) found.set(p.pid, { ...p, why: 'runs from a Pholama folder' });
  }
  for (const f of pidFiles) {
    const pid = readPid(f); if (!pid || pid === self) continue;
    const p = byPid.get(pid); if (!p) continue;   // no longer running
    if (/llama-server|pholama/i.test(p.name + ' ' + p.exe) || (p.exe && insideAny(p.exe, roots))) found.set(pid, { ...p, why: 'listed in ' + path.basename(f) });
    // a plain "node" in a pid file that does NOT live in a Pholama folder may be the user's own node: left alone
  }
  return [...found.values()];
}

function killTree(pid, platform = process.platform, run = (c, a) => cp.execFileSync(c, a, { timeout: 15000, windowsHide: true, stdio: 'ignore' })) {
  try {
    if (platform === 'win32') run('taskkill', ['/pid', String(pid), '/t', '/f']);
    else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
    return true;
  } catch { return false; }
}

// Ask nicely first (if the server answers), then force. Returns { stopped:[...], failed:[...], left:[...] }.
async function stopAll(roots, { list = listProcesses, kill = killTree, exists = alive, polite = async () => {}, wait = ms => new Promise(r => setTimeout(r, ms)), pidFiles = [], self = process.pid, tries = 4, readPid } = {}) {
  try { await polite(); } catch {}
  await wait(500);
  const stopped = [], failed = [], seen = new Set();
  for (let i = 0; i < tries; i++) {
    const procs = pholamaProcesses(roots, { list, self, pidFiles, ...(readPid ? { readPid } : {}) });
    if (!procs.length) break;
    for (const p of procs) { seen.add(p.pid); if (kill(p.pid)) { if (!stopped.some(s => s.pid === p.pid)) stopped.push(p); } }
    await wait(700);
  }
  const left = pholamaProcesses(roots, { list, self, pidFiles, ...(readPid ? { readPid } : {}) });
  for (const p of left) failed.push(p);
  for (const f of pidFiles) { try { fs.unlinkSync(f); } catch {} }
  return { stopped, failed, left: left.map(p => p.pid), unreadable: (() => { try { list(); return false; } catch { return true; } })() };
}
module.exports = { stopAll, pholamaProcesses, listProcesses, killTree, insideAny, PID_FILES };
