# Removes mcp-toggle from this Windows user and puts everything back the way it
# was: parked MCP servers go back into their apps' configs, the desktop shortcut
# and the sign-in reset are removed, and the leftover files are deleted.
#
# Every file it will change is copied to ~\.mcp-toggle-backup\<time> first, and
# nothing is deleted unless a final check shows the servers are back.
#
#   -Yes        don't ask before starting
#   -KeepData   leave ~\.mcp-toggle (the parked-server list and logs) in place
param([switch]$Yes, [switch]$KeepData)

$ErrorActionPreference = 'Stop'

$cli = Join-Path $PSScriptRoot 'mcp-toggle.mjs'
$installer = Join-Path $PSScriptRoot 'install.ps1'
$stateDir = Join-Path $env:USERPROFILE '.mcp-toggle'
$stash = Join-Path $stateDir 'disabled.json'
$backupDir = Join-Path $env:USERPROFILE ('.mcp-toggle-backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskName = 'mcp-toggle off-all at log on'
# An unusual profile can have no Desktop or Startup folder; then there is no shortcut to find.
function Get-ShortcutPath($folder, $name) {
  $dir = [Environment]::GetFolderPath($folder)
  if ($dir) { Join-Path $dir $name } else { Join-Path $env:TEMP "no-$folder-folder\$name" }
}
$desktopLnk = Get-ShortcutPath 'Desktop' 'MCP Servers.lnk'
$startupLnk = Get-ShortcutPath 'Startup' 'mcp-toggle off-all.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MCP servers off at login'

# Runs one step in a background job so a / - \ | spinner can turn while it
# works. The step returns @{ Ok; Detail; Warn }; a step that throws is a failure.
function Invoke-Step {
  param([string]$Title, [scriptblock]$Work, $Context)
  $job = Start-Job -ScriptBlock $Work -ArgumentList $Context
  $frames = '/', '-', '\', '|'
  $i = 0
  while ($job.State -eq 'Running') {
    Write-Host ("`r  [{0}] {1}" -f $frames[$i % 4], $Title) -NoNewline
    $i++
    Start-Sleep -Milliseconds 100
  }
  $out = @(Receive-Job $job -ErrorAction SilentlyContinue)
  $result = if ($out.Count -and $out[-1] -is [System.Collections.IDictionary]) {
    $out[-1]
  } else {
    $why = if ($job.ChildJobs[0].JobStateInfo.Reason) { $job.ChildJobs[0].JobStateInfo.Reason.Message } else { 'the step produced no result' }
    @{ Ok = $false; Detail = $why }
  }
  Remove-Job $job -Force
  Write-Host ("`r" + (' ' * 78) + "`r") -NoNewline
  if (-not $result.Ok) {
    Write-Host '  [!!] ' -ForegroundColor Red -NoNewline
  } elseif ($result.Warn) {
    Write-Host '  [ok] ' -ForegroundColor Yellow -NoNewline
  } else {
    Write-Host '  [ok] ' -ForegroundColor Green -NoNewline
  }
  Write-Host $Title -NoNewline
  if ($result.Detail) { Write-Host ("  - " + $result.Detail) -ForegroundColor DarkGray } else { Write-Host '' }
  $result
}

Write-Host ''
Write-Host '  mcp-toggle uninstall' -ForegroundColor Cyan
Write-Host ''

# Where each app keeps its config comes from mcp-toggle itself, so the two can't disagree.
try {
  $nodeCommand = (Get-Command node -ErrorAction Stop).Source
  $moduleUrl = ([uri]$cli).AbsoluteUri
  $apps = & $nodeCommand --input-type=module -e "import { APPS } from '$moduleUrl'; console.log(JSON.stringify(APPS.map(a => ({ id: a.id, file: a.file }))))" | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $apps) { throw 'node could not load mcp-toggle.mjs' }
} catch {
  Write-Host "  Can't start: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  mcp-toggle needs Node.js 20 or later to restore your servers. Nothing was changed.'
  exit 1
}

$files = @($apps | ForEach-Object { @{ Name = "$($_.id)-$(Split-Path $_.file -Leaf)"; Path = $_.file } })
$files += @{ Name = 'disabled.json'; Path = $stash }
$files += @{ Name = 'off-all.log'; Path = (Join-Path $stateDir 'off-all.log') }

$open = @()
if (Get-Process -Name 'claude' -ErrorAction SilentlyContinue) { $open += 'Claude' }
if (Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue) { $open += 'LM Studio' }

Write-Host '  This will:'
Write-Host '    1. back up your app configs and the parked-server list'
Write-Host '    2. put parked servers back into each app''s config'
Write-Host '    3. remove the desktop shortcut and the sign-in reset'
Write-Host '    4. check that everything is back'
Write-Host '    5. delete ~\.mcp-toggle (only if the check passes)'
Write-Host ''
if ($open) {
  $verb = if ($open.Count -gt 1) { 'are' } else { 'is' }
  Write-Host ("  Warning: {0} {1} running. A running app can save an older copy of its config" -f ($open -join ' and '), $verb) -ForegroundColor Yellow
  Write-Host '  over the restored servers. Quit it first (Claude Desktop: from the tray) for the' -ForegroundColor Yellow
  Write-Host '  safest result. Step 4 will tell you if that happened.' -ForegroundColor Yellow
  Write-Host ''
}
if (-not $Yes) {
  $answer = Read-Host '  Continue? [y/N]'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host '  Nothing was changed.'
    exit 0
  }
  Write-Host ''
}

$failed = $false

# 1. Back up. If a copy can't be made and checked, stop before changing anything.
$r = Invoke-Step 'Backing up configs and the parked-server list' {
  param($c)
  try {
    New-Item -ItemType Directory -Force $c.BackupDir | Out-Null
    $copied = 0
    foreach ($f in $c.Files) {
      if (-not (Test-Path -LiteralPath $f.Path)) { continue }
      $dest = Join-Path $c.BackupDir $f.Name
      Copy-Item -LiteralPath $f.Path -Destination $dest
      if ((Get-FileHash -LiteralPath $f.Path).Hash -ne (Get-FileHash -LiteralPath $dest).Hash) {
        throw "the copy of $($f.Name) doesn't match the original"
      }
      $copied++
    }
    @{ Ok = $true; Detail = "$copied file(s) in $($c.BackupDir)" }
  } catch {
    @{ Ok = $false; Detail = $_.Exception.Message }
  }
} @{ BackupDir = $backupDir; Files = $files }
if (-not $r.Ok) {
  Write-Host ''
  Write-Host '  Stopped before changing anything.' -ForegroundColor Red
  exit 1
}

# 2. Restore every parked server with mcp-toggle's own "on", which keeps each
# file's formatting and writes it atomically.
$r = Invoke-Step 'Restoring parked servers' {
  param($c)
  try {
    if (-not (Test-Path -LiteralPath $c.Stash)) { return @{ Ok = $true; Detail = 'nothing was parked' } }
    $parked = Get-Content -LiteralPath $c.Stash -Raw | ConvertFrom-Json
    $restored = 0
    $problems = @()
    foreach ($app in $parked.PSObject.Properties) {
      foreach ($server in $app.Value.PSObject.Properties) {
        $ErrorActionPreference = 'Continue'
        $output = (& $c.Node $c.Cli on $app.Name $server.Name 2>&1 | ForEach-Object {
          if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        }) -join ' '
        if ($LASTEXITCODE -eq 0) { $restored++ } else { $problems += "$($app.Name)/$($server.Name): $($output.Trim())" }
      }
    }
    if ($problems) { return @{ Ok = $false; Detail = "$restored restored; left parked: " + ($problems -join ' | ') } }
    @{ Ok = $true; Detail = if ($restored) { "$restored server(s) restored" } else { 'nothing was parked' } }
  } catch {
    @{ Ok = $false; Detail = $_.Exception.Message }
  }
} @{ Stash = $stash; Node = $nodeCommand; Cli = $cli }
if (-not $r.Ok) { $failed = $true }

# 3. Remove the shortcut and the sign-in reset.
$r = Invoke-Step 'Removing the shortcut and sign-in reset' {
  param($c)
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $c.Installer -Uninstall 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $output.Trim() }
    @{ Ok = $true; Detail = '' }
  } catch {
    @{ Ok = $false; Detail = $_.Exception.Message }
  }
} @{ Installer = $installer }
if (-not $r.Ok) { $failed = $true }

# 4. Check it all from the outside: nothing parked, nothing left behind.
$r = Invoke-Step 'Checking that everything is back' {
  param($c)
  try {
    $problems = @()
    $ErrorActionPreference = 'Continue'
    $listing = & $c.Node $c.Cli list 2>&1
    foreach ($line in $listing) {
      if ("$line" -match "^(\w+)\toff\t(.+)$") { $problems += "$($Matches[2]) is still switched off in $($Matches[1])" }
    }
    # `list` can't see an app whose config is missing, so read the parked list itself too.
    if (Test-Path -LiteralPath $c.Stash) {
      $left = Get-Content -LiteralPath $c.Stash -Raw | ConvertFrom-Json
      foreach ($app in $left.PSObject.Properties) {
        foreach ($server in $app.Value.PSObject.Properties) {
          $alreadyListed = @($problems | Where-Object { $_ -match [regex]::Escape($server.Name) }).Count -gt 0
          if (-not $alreadyListed) { $problems += "$($server.Name) is still parked for $($app.Name)" }
        }
      }
    }
    if (Get-ScheduledTask -TaskName $c.TaskName -ErrorAction SilentlyContinue) { $problems += 'the scheduled task is still there' }
    if (Test-Path -LiteralPath $c.StartupLnk) { $problems += 'the Startup-folder shortcut is still there' }
    if (Test-Path -LiteralPath $c.DesktopLnk) { $problems += 'the desktop shortcut is still there' }
    if (Get-ItemProperty $c.RunKey -Name $c.RunName -ErrorAction SilentlyContinue) { $problems += 'the old Run entry is still there' }
    if ($problems) { return @{ Ok = $false; Detail = ($problems -join '; ') } }
    @{ Ok = $true; Detail = '' }
  } catch {
    @{ Ok = $false; Detail = $_.Exception.Message }
  }
} @{ Node = $nodeCommand; Cli = $cli; Stash = $stash; TaskName = $taskName; StartupLnk = $startupLnk; DesktopLnk = $desktopLnk; RunKey = $runKey; RunName = $runName }
if (-not $r.Ok) { $failed = $true }

# 5. Only clean up once the check has passed, so a problem never costs you the
# parked-server list.
if ($failed) {
  Write-Host '  [--] Keeping ~\.mcp-toggle, since something above needs a look' -ForegroundColor Yellow
} elseif ($KeepData) {
  Write-Host '  [--] Keeping ~\.mcp-toggle, as asked' -ForegroundColor Yellow
} else {
  $r = Invoke-Step 'Deleting ~\.mcp-toggle' {
    param($c)
    try {
      Remove-Item -LiteralPath $c.StateDir -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $c.StateDir) { throw 'some files could not be deleted' }
      @{ Ok = $true; Detail = '' }
    } catch {
      @{ Ok = $false; Detail = $_.Exception.Message }
    }
  } @{ StateDir = $stateDir }
  if (-not $r.Ok) { $failed = $true }
}

Write-Host ''
if ($failed) {
  Write-Host '  Finished with problems.' -ForegroundColor Red
  Write-Host "  Your files are backed up in $backupDir"
  Write-Host '  Fix what is marked [!!] above and run this again; it is safe to repeat.'
  exit 1
}
Write-Host '  Done. mcp-toggle is removed.' -ForegroundColor Green
Write-Host "  Backup of the files it changed: $backupDir"
Write-Host '  It can hold server settings such as API keys; delete it once your servers work.'
Write-Host "  You can delete this folder too: $PSScriptRoot"
exit 0
