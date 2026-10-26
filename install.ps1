# Sets up mcp-toggle for this Windows user: a desktop shortcut that opens the
# switchboard, and a login entry that switches every MCP server off so each
# session starts lean. Run with -Uninstall to remove both.
param([switch]$Uninstall)

$script = Join-Path $PSScriptRoot 'mcp-toggle.mjs'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MCP Servers.lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MCP servers off at login'

if ($Uninstall) {
  Remove-Item $shortcut -ErrorAction SilentlyContinue
  Remove-ItemProperty $runKey -Name $runName -ErrorAction SilentlyContinue
  'Removed the desktop shortcut and the login entry.'
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

# conhost --headless runs the reset without flashing a console window at login.
$command = "conhost.exe --headless `"$node`" `"$script`" off-all"
Set-ItemProperty $runKey -Name $runName -Value $command

"Desktop shortcut: $shortcut"
"Login entry:      $command"
