# Uninstalling mcp-toggle

## The quick way

Quit Claude (Claude Desktop: from the tray) and LM Studio, then run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Repos\mcp-toggle\uninstall.ps1
```

It backs up every file it will change to `~\.mcp-toggle-backup\<time>`, puts
parked servers back into their apps' configs, removes the desktop shortcut and
the sign-in reset, checks that everything is back, and only then deletes
`~\.mcp-toggle`. If any step fails it keeps your data and says what to fix; it
is safe to run again. `-Yes` skips the confirmation and `-KeepData` leaves
`~\.mcp-toggle` in place. The backup can contain server settings such as API
keys, so delete it once your servers work.

## By hand

The same steps, done manually. Do them in order. Step 2 matters most: servers
the sign-in reset switched off live only in `~/.mcp-toggle/disabled.json`, and
`install.ps1 -Uninstall` does not put them back.

## What mcp-toggle changes

| What | Where |
|---|---|
| **MCP Servers** desktop shortcut | `Desktop\MCP Servers.lnk` |
| Sign-in reset | scheduled task `mcp-toggle off-all at log on`, or, if Windows wouldn't register it, the Startup-folder shortcut `mcp-toggle off-all.lnk` |
| Parked servers (removed from each app's config) | `~/.mcp-toggle/disabled.json` |
| Reset log | `~/.mcp-toggle/off-all.log` |
| Edits to each app's `mcpServers` list | `claude_desktop_config.json`, `~/.claude.json`, `~/.lmstudio/mcp.json` |

It changes nothing else: no other Windows settings, startup entries or services.

## 1. Quit the apps

Quit Claude Desktop (from the tray), any open Claude Code sessions, and LM
Studio. A running app can overwrite a config file you've just edited with an
older copy it has in memory, which would undo step 2.

## 2. Put parked servers back

From the repo folder:

```powershell
node mcp-toggle.mjs list
```

Each line is `<app>  <on|off>  <server>`. Every server marked `off` is parked in
`disabled.json`. To get one back in its app's config:

```powershell
node mcp-toggle.mjs on <desktop|code|lmstudio> <server>
```

Repeat for each server you want to keep. If `list` prints nothing, or only `on`
servers, there is nothing to restore.

Check that nothing is left parked:

```powershell
node mcp-toggle.mjs list
```

Every server you want should now show `on`. Skip any you no longer need; they
disappear when you delete `~/.mcp-toggle` in step 5.

## 3. Remove the shortcut and the sign-in reset

```powershell
powershell -ExecutionPolicy Bypass -File C:\Repos\mcp-toggle\install.ps1 -Uninstall
```

This deletes the desktop shortcut and removes the scheduled task, the
Startup-folder shortcut and the old `Run` registry entry, whichever exist. It
prints `Removed the desktop shortcut and the login reset.`

## 4. Check the reset is gone

```powershell
Get-ScheduledTask 'mcp-toggle off-all at log on' -ErrorAction SilentlyContinue
Test-Path "$([Environment]::GetFolderPath('Startup'))\mcp-toggle off-all.lnk"
Test-Path "$([Environment]::GetFolderPath('Desktop'))\MCP Servers.lnk"
```

The first should print nothing and the other two should print `False`. If the
task is still there (this can need an admin PowerShell):

```powershell
Unregister-ScheduledTask -TaskName 'mcp-toggle off-all at log on' -Confirm:$false
```

## 5. Delete the leftover files

Only after step 2, because `disabled.json` holds any servers you didn't restore:

```powershell
Remove-Item -Recurse "$env:USERPROFILE\.mcp-toggle"
```

Then, if you won't use it again, delete the repo folder (`C:\Repos\mcp-toggle`).
Keeping it costs nothing, and it is also on GitHub.

## 6. Open the apps

On the next launch each app starts whatever is in its `mcpServers` list, as it
would without mcp-toggle. Node.js was only a dependency, so remove it too if
nothing else uses it.

`install.ps1` never turned Claude Desktop's or LM Studio's open-at-sign-in
setting on or off. It only warned about it, so Settings > Apps > Startup is
whatever you set yourself.
