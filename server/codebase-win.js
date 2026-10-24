'use strict';
// Pholama Codebase: the Windows runner. It only EXECUTES what codebase-plan.js already checked.
// Values the model chose (paths, titles, text) are passed to PowerShell through environment variables, never pasted into the script,
// so no quoting trick can turn data into code. Every script is a fixed constant below.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const TIMEOUT_MS = 60000, MAX_OUT = 20000;

// ---- fixed PowerShell scripts. $env:PH_A / PH_B / PH_N hold the data. ----
const PS = {
  screenshot: `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$s=[double]$env:PH_N; if($s -le 0 -or $s -gt 1){$s=0.5}
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $g.Dispose()
$w=[int]($b.Width*$s); $h=[int]($b.Height*$s)
$small=New-Object System.Drawing.Bitmap $bmp,$w,$h
$small.Save($env:PH_A,[System.Drawing.Imaging.ImageFormat]::Png); $small.Dispose(); $bmp.Dispose()
Write-Output "saved"`,
  windows: `
Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle } | Sort-Object -Unique`,
  open: `Start-Process -FilePath $env:PH_A`,
  notepad: `Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $env:PH_A + '"'); Write-Output "opened in Notepad"`,   // the agent's notes window: Notepad itself, with a path that came from Pholama, never from the model
  close: `
$t=$env:PH_A; $n=0
Get-Process | Where-Object { $_.MainWindowTitle -eq $t } | ForEach-Object { if($_.CloseMainWindow()){$n++} }
Write-Output "closed $n window(s) titled '$t'"`,
  write: `
$d=Split-Path -Parent $env:PH_A; if($d -and -not (Test-Path -LiteralPath $d)){ throw 'The folder does not exist.' }
[System.IO.File]::WriteAllText($env:PH_A,[Console]::In.ReadToEnd(),(New-Object System.Text.UTF8Encoding $false)); Write-Output "wrote"`,
  append: `
$d=Split-Path -Parent $env:PH_A; if($d -and -not (Test-Path -LiteralPath $d)){ throw 'The folder does not exist.' }
[System.IO.File]::AppendAllText($env:PH_A,[Console]::In.ReadToEnd(),(New-Object System.Text.UTF8Encoding $false)); Write-Output "added to the end of the file"`,
  create_file: `
if(Test-Path -LiteralPath $env:PH_A){ throw 'That file already exists.' }
[System.IO.File]::WriteAllText($env:PH_A,[Console]::In.ReadToEnd(),(New-Object System.Text.UTF8Encoding $false)); Write-Output "created"`,
  create_folder: `New-Item -ItemType Directory -Path $env:PH_A -ErrorAction Stop | Out-Null; Write-Output "created"`,
  move: `if(Test-Path -LiteralPath $env:PH_B){ throw 'The destination already exists.' }; Move-Item -LiteralPath $env:PH_A -Destination $env:PH_B -ErrorAction Stop; Write-Output "moved"`,
  delete: `Remove-Item -LiteralPath $env:PH_A -Recurse -Force -ErrorAction Stop; Write-Output "deleted"`,
  read: `Get-Content -LiteralPath $env:PH_A -Raw -ErrorAction Stop`,
  clip_set: `Set-Clipboard -Value ([Console]::In.ReadToEnd()); Write-Output "copied"`,
  clip_get: `Get-Clipboard -Raw`,
  img_copy: `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile($env:PH_A)); Write-Output "image copied"`,
  paste: `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); Write-Output "pasted"`,
  // the agent's own small pointer: it sends the click to the window under that point; the user's real mouse is not moved.
  // A REAL mouse: the cursor moves to the spot and the button is pressed the way a hand would. (The old background message was ignored by browsers.)
  // PH_A = x, PH_B = y, PH_N = what to do: move | click | double | right | scroll:<notches, negative = down>
  pc_mouse: `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PhMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,int d,UIntPtr e); }
"@
$x=[int]$env:PH_A; $y=[int]$env:PH_B; $do=[string]$env:PH_N
Add-Type -AssemblyName System.Windows.Forms
$v=[System.Windows.Forms.SystemInformation]::VirtualScreen
if($x -ge 0 -or $y -ge 0){
  if($x -lt $v.Left -or $y -lt $v.Top -or $x -gt $v.Right -or $y -gt $v.Bottom){ throw 'That spot is not on the screen.' }
  [void][PhMouse]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 120
}
switch -Regex ($do){
  '^move$'   { Write-Output "moved to $x,$y" }
  '^click$'  { [PhMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [PhMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Write-Output "clicked at $x,$y" }
  '^double$' { 1..2 | ForEach-Object { [PhMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [PhMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }; Write-Output "double-clicked at $x,$y" }
  '^right$'  { [PhMouse]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [PhMouse]::mouse_event(16,0,0,0,[UIntPtr]::Zero); Write-Output "right-clicked at $x,$y" }
  '^scroll:(-?\d+)$' { $n=[int]$Matches[1]; [PhMouse]::mouse_event(0x0800,0,0,($n*120),[UIntPtr]::Zero); Write-Output "scrolled $n" }
  default    { throw 'Unknown mouse action.' }
}`,
  // Wait: a short pause so a page can load (the planner limits it to 1 to 20 seconds).
  pc_wait: `Start-Sleep -Seconds ([int]$env:PH_A); Write-Output "waited $($env:PH_A) seconds"`,
  // Text is typed literally: every SendKeys special character is escaped, and a line break becomes the Enter key. PH_A=1 presses Enter at the end.
  pc_type: `Add-Type -AssemblyName System.Windows.Forms; $t=[Console]::In.ReadToEnd() -replace "\r\n","\n"; $t=$t -replace '([+^%~(){}\\[\\]])','{$1}'; $t=$t -replace "\n","{ENTER}"; if($env:PH_A -eq '1'){$t=$t+'{ENTER}'}; [System.Windows.Forms.SendKeys]::SendWait($t); Write-Output "typed"`,
  pc_key: `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:PH_A); Write-Output "pressed"`,
};

// Run one fixed script. Data goes in via env vars and stdin only.
function ps(name, { a = '', b = '', n = '', stdin = '', timeout = TIMEOUT_MS, cwd } = {}) {
  return new Promise(resolve => {
    if (!Object.prototype.hasOwnProperty.call(PS, name)) return resolve({ ok: false, text: 'Unknown action.' });
    if (process.platform !== 'win32') return resolve({ ok: false, text: 'This tool only works on Windows.' });
    let out = '', err = '', done = false;
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS[name]], { windowsHide: true, cwd, env: { ...process.env, PH_A: String(a), PH_B: String(b), PH_N: String(n) } });
    const fin = r => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { try { c.kill(); } catch {} fin({ ok: false, text: 'Timed out.' }); }, timeout);
    c.stdout.on('data', d => { if (out.length < MAX_OUT) out += d; }); c.stderr.on('data', d => { if (err.length < 2000) err += d; });
    c.on('error', e => fin({ ok: false, text: 'Could not start PowerShell.' }));
    c.on('close', code => fin({ ok: code === 0, text: (code === 0 ? out : (err || out || 'Failed.')).trim().slice(0, MAX_OUT) }));
    try { c.stdin.end(stdin); } catch {}
  });
}

// A free-form command the user explicitly allowed, run in the chosen folder. The command text IS the code here, which is why it is strict-approved and filtered by the planner.
function shell(kind, command, cwd) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, text: 'This tool only works on Windows.' });
    let out = '', done = false;
    const exe = kind === 'terminal' ? 'cmd.exe' : 'powershell.exe';
    const args = kind === 'terminal' ? ['/d', '/s', '/c', command] : ['-NoProfile', '-NonInteractive', '-Command', command];
    const c = spawn(exe, args, { windowsHide: true, cwd: cwd || undefined, windowsVerbatimArguments: kind === 'terminal' });
    const fin = r => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { try { c.kill(); } catch {} fin({ ok: false, text: (out + '\n[stopped after ' + TIMEOUT_MS / 1000 + 's]').trim().slice(0, MAX_OUT) }); }, TIMEOUT_MS);
    c.stdout.on('data', d => { if (out.length < MAX_OUT) out += d; }); c.stderr.on('data', d => { if (out.length < MAX_OUT) out += d; });
    c.on('error', () => fin({ ok: false, text: 'Could not start.' }));
    c.on('close', code => fin({ ok: code === 0, text: out.trim().slice(0, MAX_OUT) || (code === 0 ? '(no output)' : 'Exit code ' + code) }));
    try { c.stdin.end(); } catch {}
  });
}

// Execute a PLAN from codebase-plan.js. Returns text for the model. `ctx` holds things only the app knows (the screenshot reader, the notes, the windows the agent opened).
async function execute(pl, ctx = {}) {
  if (!pl || pl.ok !== true) return { ok: false, text: (pl && pl.say) || 'Not allowed.' };
  switch (pl.kind) {
    case 'screenshot': {
      const f = path.join(os.tmpdir(), 'pholama-shot-' + process.pid + '-' + Date.now() + '.png');
      const r = await ps('screenshot', { a: f, n: pl.scale });
      if (!r.ok) return r;
      let say = 'Screenshot taken.', shot = null;
      try { try { shot = require('./codebase-shots').put(fs.readFileSync(f)); } catch {} if (ctx.readImage) say = await ctx.readImage(f); } finally { try { fs.unlinkSync(f); } catch {} }
      const w = await ps('windows'); const titles = w.ok ? w.text.split(/\r?\n/).filter(Boolean).filter(t => !ctx.opened || ctx.opened.has(t)) : [];
      return { ok: true, shot, text: say + '\nOPEN WINDOWS (opened by the agent, closable): ' + JSON.stringify(titles) };
    }
    case 'pull': return ps('read', { a: pl.from });
    case 'write': return ps(pl.append ? 'append' : 'write', { a: pl.path, stdin: pl.content });
    case 'create': return pl.type === 'folder' ? ps('create_folder', { a: pl.path }) : ps('create_file', { a: pl.path, stdin: pl.content });
    case 'move': return ps('move', { a: pl.from, b: pl.to });
    case 'delete': return ps('delete', { a: pl.path });
    case 'notepad': return ps('notepad', { a: pl.path });
    case 'open': { const r = await ps('open', { a: pl.target }); if (r.ok && ctx.opened) ctx.opened.add(pl.target); return r; }
    case 'close': {
      if (ctx.opened && !ctx.opened.has(pl.title)) return { ok: false, text: 'REFUSED: that window was not opened by the agent. Pick one from OPEN WINDOWS exactly.' };
      const r = await ps('close', { a: pl.title }); if (r.ok && ctx.opened) ctx.opened.delete(pl.title); return r;
    }
    case 'clip_set': return ps('clip_set', { stdin: pl.text });
    case 'paste': return ps('paste');
    case 'img_copy': return ps('img_copy', { a: pl.path });
    case 'pc_move': return ps('pc_mouse', { a: pl.x, b: pl.y, n: 'move' });
    case 'pc_click': return ps('pc_mouse', { a: pl.x, b: pl.y, n: 'click' });
    case 'pc_double': return ps('pc_mouse', { a: pl.x, b: pl.y, n: 'double' });
    case 'pc_right': return ps('pc_mouse', { a: pl.x, b: pl.y, n: 'right' });
    case 'pc_scroll': return ps('pc_mouse', { a: pl.x, b: pl.y, n: 'scroll:' + pl.amount });
    case 'pc_wait': return ps('pc_wait', { a: pl.seconds });
    case 'pc_type': return ps('pc_type', { stdin: pl.text, a: pl.enter ? '1' : '0' });
    case 'pc_key': return ps('pc_key', { a: pl.send });
    case 'terminal': case 'powershell': return shell(pl.kind, pl.command, pl.cwd);
    default: return { ok: false, text: 'This action is not available on this PC yet.' };
  }
}
module.exports = { execute, ps, shell, PS, TIMEOUT_MS };
