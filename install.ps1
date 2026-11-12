# Sets up mcp-toggle for this Windows user: a desktop shortcut that opens the
# switchboard, and a login reset that switches every MCP server off so nothing
# starts until you switch it on. Run with -Uninstall to remove both, or
# -CheckStartup to only check for apps that open at sign-in.
param([switch]$Uninstall, [switch]$CheckStartup)

$script = Join-Path $PSScriptRoot 'mcp-toggle.mjs'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MCP Servers.lnk'
$taskName = 'mcp-toggle off-all at log on'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'mcp-toggle off-all.lnk'
# Earlier versions used a Run registry entry, which Windows was seen skipping at sign-in.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MCP servers off at login'

function Remove-LoginReset {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $startupLnk -ErrorAction SilentlyContinue
  Remove-ItemProperty $runKey -Name $runName -ErrorAction SilentlyContinue
}

# An app that opens at sign-in can read its config before the reset runs and
# start its servers anyway. Entries are matched by the program they start, not
# their name, so a shortcut merely named after Claude isn't flagged.
$launcherPattern = '(^|[\\/"\s])(claude|lm[ -]?studio)\.exe'

# Settings > Apps > Startup keeps its on/off switch for Run entries and
# Startup-folder shortcuts under StartupApproved: an odd first byte means off.
# An entry with no switch recorded is on.
function Test-StartupApproved([string[]]$ApprovedKeys, [string]$Name) {
  foreach ($path in $ApprovedKeys) {
    $key = Get-Item $path -ErrorAction SilentlyContinue
    if (-not $key) { continue }
    $bytes = $key.GetValue($Name)
    if ($bytes) { return -not ($bytes[0] -band 1) }
  }
  $true
}

function Get-SignInLaunchers {
  param(
    [string]$AppModelRoot = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData',
    [string]$UserApproved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved',
    [string]$MachineApproved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved',
    [object[]]$RunKeys = @(
      @{ Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; Label = 'HKCU'; Approved = "$UserApproved\Run" }
      @{ Path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'; Label = 'HKLM'; Approved = "$UserApproved\Run", "$MachineApproved\Run" }
      @{ Path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; Label = 'HKLM 32-bit'; Approved = "$UserApproved\Run32", "$MachineApproved\Run32" }
    ),
    [object[]]$StartupFolders = @(
      @{ Path = [Environment]::GetFolderPath('Startup'); Approved = "$UserApproved\StartupFolder" }
      @{ Path = [Environment]::GetFolderPath('CommonStartup'); Approved = "$UserApproved\StartupFolder", "$MachineApproved\StartupFolder" }
    )
  )
  $appName = { param($text) if ($text -match 'lm[ -]?studio') { 'LM Studio' } else { 'Claude' } }

  # The Store build of Claude. State 2 is on; 4 is on by an organization's policy.
  Get-ChildItem $AppModelRoot -ErrorAction SilentlyContinue |
    Where-Object PSChildName -like 'Claude_*' |
    ForEach-Object { Get-ItemProperty (Join-Path $_.PSPath 'ClaudeStartup') -ErrorAction SilentlyContinue } |
    Where-Object { $_.State -in 2, 4 } |
    ForEach-Object { [pscustomobject]@{ App = 'Claude'; Where = 'Store app startup task'; Policy = $_.State -eq 4 } }

  # The classic Claude install and LM Studio add a Run entry.
  foreach ($run in $RunKeys) {
    $key = Get-Item $run.Path -ErrorAction SilentlyContinue
    if (-not $key) { continue }
    foreach ($name in $key.GetValueNames()) {
      $command = "$($key.GetValue($name))"
      if ($command -match $launcherPattern -and (Test-StartupApproved $run.Approved $name)) {
        [pscustomobject]@{ App = & $appName $command; Where = "Run registry entry '$name' ($($run.Label))"; Policy = $false }
      }
    }
  }

  # A shortcut, or the program itself, in a Startup folder.
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in $StartupFolders) {
    foreach ($file in Get-ChildItem $folder.Path -File -ErrorAction SilentlyContinue) {
      $target = $file.FullName
      if ($file.Extension -eq '.lnk') {
        $lnk = $shell.CreateShortcut($file.FullName)
        $target = "$($lnk.TargetPath) $($lnk.Arguments)"
      }
      if ($target -match $launcherPattern -and (Test-StartupApproved $folder.Approved $file.Name)) {
        [pscustomobject]@{ App = & $appName $target; Where = "Startup folder shortcut '$($file.FullName)'"; Policy = $false }
      }
    }
  }
}

function Show-SignInLaunchers {
  $found = @(Get-SignInLaunchers)
  if (-not $found) {
    'Startup check:    Claude and LM Studio are not set to open at sign-in'
    return
  }
  'Warning: these open at sign-in, so they can start before the reset and launch'
  '         servers that were left on. Turn them off in Settings > Apps > Startup.'
  foreach ($f in $found) {
    $note = if ($f.Policy) { ' (turned on by an organization policy; Settings may not let you turn it off)' } else { '' }
    "         - $($f.App): $($f.Where)$note"
  }
}

if ($CheckStartup) {
  Show-SignInLaunchers
  return
}

if ($Uninstall) {
  Remove-Item $shortcut -ErrorAction SilentlyContinue
  Remove-LoginReset
  'Removed the desktop shortcut and the login reset.'
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$stateDir = Join-Path $env:USERPROFILE '.mcp-toggle'
New-Item -ItemType Directory -Force $stateDir | Out-Null

$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$lnk.TargetPath = $node
$lnk.Arguments = "`"$script`""
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.IconLocation = (Join-Path $PSScriptRoot 'mcp-toggle.ico') + ',0'
$lnk.Description = 'Turn MCP servers on and off'
$lnk.Save()
"Desktop shortcut: $shortcut"

# conhost --headless runs the reset without a console window.
Remove-LoginReset
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$resetArgs = "--headless `"$node`" `"$script`" off-all"
try {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $task = @{
    TaskName  = $taskName
    Action    = New-ScheduledTaskAction -Execute $conhost -Argument $resetArgs
    Trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
    Principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  }
  Register-ScheduledTask @task -ErrorAction Stop | Out-Null
  "Login reset:      scheduled task '$taskName'"
} catch {
  # Registering a log-on task can need admin rights. A Startup-folder shortcut
  # doesn't, but Windows starts those a few seconds later in sign-in.
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($startupLnk)
  $lnk.TargetPath = $conhost
  $lnk.Arguments = $resetArgs
  $lnk.WindowStyle = 7
  $lnk.Save()
  "Login reset:      Startup folder shortcut $startupLnk"
  "                  (scheduled task not registered: $($_.Exception.Message))"
}

Show-SignInLaunchers
