# Sets up mcp-toggle for this Windows user: a desktop shortcut that opens the
# switchboard, and a login reset that switches every MCP server off so nothing
# starts until you switch it on. Run with -Uninstall to remove both.
param([switch]$Uninstall)

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
