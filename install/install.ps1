# Pholama installer for Windows. In PowerShell run:
#   irm https://raw.githubusercontent.com/genity5-collab/Pholama-PC/main/install/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE 'Pholama'
$zip = 'https://github.com/genity5-collab/Pholama-PC/archive/refs/heads/main.zip'
function Say($m) { Write-Host ""; Write-Host "  $m" }

# Clean up after older attempts that failed or were closed half-way: leftover download folders and zips in TEMP, and a half-finished install
# (a Pholama folder that has no server\cli.js). Only things older than 10 minutes are removed, so a second window that is installing right now is never hurt.
function Clean-OldAttempts {
  $cut = (Get-Date).AddMinutes(-10); $n = 0
  try {
    Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(pholama_[0-9a-f]{32}|nodex_[0-9a-f]{32}|node_[0-9a-f]{32}\.zip)$' -and $_.LastWriteTime -lt $cut } |
      ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; $n++ }
  } catch { }
  try {
    # A half-finished install: the folder exists but has no program in it. (A working install is never touched here.)
    if ((Test-Path $dir) -and -not (Test-Path (Join-Path $dir 'server\cli.js'))) {
      $keep = Get-ChildItem $dir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'node_modules' }
      if ($keep) { $keep | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; $n++ }
    }
  } catch { }
  if ($n -gt 0) { Say "Cleaned up $n leftover file(s) from an earlier attempt that did not finish." }
}
Clean-OldAttempts

# Use the Node.js already on this PC when it is new enough; otherwise fetch a private copy (no install, no admin, nothing system-wide).
$nodeExe = 'node'
$ok = $false
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $nodeExe = $found.Source; try { $ok = ([int](node -p "process.versions.node.split('.')[0]")) -ge 18 } catch { $ok = $false } }
if (-not $ok) {
  $priv = Join-Path $env:USERPROFILE '.pholama\node'
  $privNode = Join-Path $priv 'node.exe'
  if (-not (Test-Path $privNode)) {
    Say "No Node.js found, so Pholama is getting its own private copy (about 30 MB, one time). Nothing is installed on your PC."
    $nv = 'v20.20.2'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $nzip = Join-Path $env:TEMP ('node_' + [guid]::NewGuid().ToString('N') + '.zip')
    $nout = Join-Path $env:TEMP ('nodex_' + [guid]::NewGuid().ToString('N'))
    try {
      Invoke-WebRequest "https://nodejs.org/dist/$nv/node-$nv-win-$arch.zip" -OutFile $nzip -UseBasicParsing
      Expand-Archive $nzip -DestinationPath $nout -Force
      $inner = Get-ChildItem $nout -Directory | Select-Object -First 1
      New-Item -ItemType Directory -Path $priv -Force | Out-Null
      Copy-Item (Join-Path $inner.FullName '*') $priv -Recurse -Force
    } catch {
      Say "Could not get Node.js ($($_.Exception.Message)). Check your internet connection and run the command again."
      return
    } finally {
      Remove-Item $nzip -Force -ErrorAction SilentlyContinue
      Remove-Item $nout -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not (Test-Path $privNode)) { Say "Node.js did not unpack correctly. Please run the command again."; return }
  $nodeExe = $privNode
}

Say "Downloading Pholama to $dir ..."
$tmp = Join-Path $env:TEMP ('pholama_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Invoke-WebRequest $zip -OutFile "$tmp\p.zip" -UseBasicParsing
  Expand-Archive "$tmp\p.zip" -DestinationPath $tmp -Force
} catch {
  Say "Could not download Pholama ($($_.Exception.Message)). Check your internet connection and run the command again."
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  return
}
# GitHub names the folder after the repo and branch (Pholama-PC-main), and that name has changed before, so find it by looking:
# the unpacked folder that holds the program. Never rely on a fixed name.
$src = $null
foreach ($d in (Get-ChildItem $tmp -Directory -ErrorAction SilentlyContinue)) { if (Test-Path (Join-Path $d.FullName 'server\cli.js')) { $src = $d.FullName; break } }
if (-not $src) { $src = Join-Path $tmp 'Pholama-PC-main' }
# Never touch an existing install unless the download really unpacked into a complete Pholama.
foreach ($f in 'server\cli.js','server\server.js','models.pc.json') {
  if (-not (Test-Path (Join-Path $src $f))) {
    Say "The download was incomplete ($f is missing), so nothing was changed. Run the command again."
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    return
  }
}
New-Item -ItemType Directory -Path $dir -Force | Out-Null
# Reinstall cleanly: replace the app code, but keep nothing stale from an older version. Models and chats live in .pholama, not here.
Get-ChildItem $dir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('node_modules') } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $src '*') $dir -Recurse -Force
Remove-Item $tmp -Recurse -Force
foreach ($f in 'server\cli.js','server\server.js','models.pc.json') {
  if (-not (Test-Path (Join-Path $dir $f))) { Say "Install failed: $f is missing in $dir. Run the command again."; return }
}
# make the pholama command available in new terminals
$bin = Join-Path $env:USERPROFILE '.pholama\cmd'; New-Item -ItemType Directory -Path $bin -Force | Out-Null
foreach ($n in 'pholama','phollama') { Set-Content -Path (Join-Path $bin "$n.cmd") -Value "@echo off`r`n`"$nodeExe`" `"$dir\server\cli.js`" %*" -Encoding ASCII }
# Background updates are optional. A native program that writes to the error stream must never abort the install, so the strict mode is relaxed for this one call
# (with $ErrorActionPreference = 'Stop', PowerShell turns any such text into a red NativeCommandError and stops).
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$schedOut = ''
try { $schedOut = (& $nodeExe (Join-Path $dir 'server\cli.js') schedule-updates 2>&1 | Out-String).Trim() } catch { $schedOut = '' }
$schedCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($schedCode -eq 0) { Say "Background updates are scheduled every 5 hours while Pholama is closed." } else { Say "Pholama could not set up automatic background updates on this PC. That is fine: it still works, and you can update any time with: pholama update" }
$path = [Environment]::GetEnvironmentVariable('Path','User')
if (($path -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$path;$bin", 'User') }
# Desktop + Start Menu shortcuts that carry the Pholama llama icon, so it is easy to spot and click
try {
  $ws = New-Object -ComObject WScript.Shell
  $targets = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pholama.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Pholama.lnk'))
  foreach ($t in $targets) {
    $sc = $ws.CreateShortcut($t)
    $sc.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $sc.Arguments = '"' + (Join-Path $dir 'install\Pholama.vbs') + '"'
    $sc.WorkingDirectory = $dir
    $sc.IconLocation = (Join-Path $dir 'install\pholama.ico') + ',0'
    $sc.Description = 'Pholama: private AI on your PC'
    $sc.Save()
  }
  Say "Added a Pholama icon (llama) to your Desktop and Start Menu. Double-click it to open Pholama."
} catch { Say "Could not add the Desktop icon ($($_.Exception.Message)). You can still double-click start.bat." }
Say "Installed. Open a NEW terminal and try:  pholama list    then:  pholama pull qwen2.5-0.5b"
Say "Or open the app now: double-click start.bat in $dir"
Set-Location $dir
& $nodeExe server\cli.js web
