# mcp-toggle

One list for switching MCP servers on and off across Claude Desktop, Claude Code
and LM Studio on Windows. Every server is switched off each time you sign in, so
nothing runs until you turn it on.

## Setup

Needs Node.js 20 or later.

```powershell
gh repo clone evancogan/mcp-toggle C:\Repos\mcp-toggle
powershell -ExecutionPolicy Bypass -File C:\Repos\mcp-toggle\install.ps1
```

The installer adds two things:

- an **MCP Servers** shortcut on the desktop, which opens the switchboard
- a sign-in reset: a scheduled task, `mcp-toggle off-all at log on`, that runs
  `off-all` with no window each time you sign in

If Windows won't register the task without admin rights, the installer puts a
shortcut in the Startup folder instead, which Windows runs a few seconds later
in sign-in. It also warns you if Claude Desktop or LM Studio is set to open at
sign-in (see [What the reset covers](#what-the-reset-covers)). It looks for the
Store app's startup task, `Run` registry entries and Startup-folder shortcuts
that start `claude.exe` or `LM Studio.exe`, and skips any you've turned off in
Settings > Apps > Startup. `install.ps1 -CheckStartup` runs only that check and
changes nothing.

Run the installer again after moving the repo or reinstalling Node.js, since the
task and shortcut point at both by full path. `install.ps1 -Uninstall` removes
the shortcut and the reset.

To remove everything and put your servers back, run `uninstall.ps1`; see
[UNINSTALL.md](UNINSTALL.md).

## Use

Open the shortcut: ↑/↓ to move, Space to switch a server on or off, r to reload,
q to quit. The bottom line shows the file writes each switch made. Restart the
app for a change to take effect.

| Command | |
|---|---|
| `node mcp-toggle.mjs` | interactive list |
| `node mcp-toggle.mjs list` | every server and its state |
| `node mcp-toggle.mjs on\|off desktop\|code\|lmstudio <name>` | switch one server |
| `node mcp-toggle.mjs off-all` | switch everything off (what the sign-in task runs) |

A server you switch on stays on until your next sign-in.

## How it works

Switching a server off moves its entry from the app's config into
`~/.mcp-toggle/disabled.json`; switching it on moves it back. The rest of each
config file is left byte-for-byte as it was. An entry is written to its new home
before it's removed from the old one, so a failed write can leave it in both
places but never lose it. Each file is written to a temp file beside it and
then renamed into place, so a crash or power cut mid-write leaves the old file
whole.

| App | Config |
|---|---|
| Claude Desktop | `%LOCALAPPDATA%\Claude-Data\claude_*\claude_desktop_config.json` (Store build) or `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude.json` (user-scope servers) |
| LM Studio / Bionic | `~/.lmstudio/mcp.json` |

`off-all` switches off every server in all three, with one write to
`disabled.json` and one to the config for each app. If one config can't be read
or written, it still switches off everything else, then logs each failure.

## What the reset covers

The reset switches servers off in the config files above. An app starts its
servers when it opens, from whatever its config says at that moment. So:

- **Covered:** any of the three apps opened after sign-in, by you or by
  anything else.
- **Not covered: apps that open at sign-in.** Claude Desktop or LM Studio set
  to open at sign-in can read its config before the reset runs and start what
  was left on. Leave them off in Settings > Apps > Startup. If your
  organization's policy turns one on, Settings may not let you turn it off.
- **Not covered: sleep and hibernate.** Waking the PC isn't a sign-in, so the
  reset doesn't run and running servers keep running. Shutting down and
  restarting both sign you in again, Fast Startup included.
- **Not covered: other kinds of server.** The switchboard only sees the
  `mcpServers` lists in the files above. It doesn't see Claude Code servers
  scoped to one project (a project's `.mcp.json`, or `projects` in
  `~/.claude.json`) or added by plugins, Claude Desktop extensions installed
  from Settings > Extensions, or connectors added on claude.ai.

## Checking it works

Each `off-all` run adds a line to `~/.mcp-toggle/off-all.log`:

```
2026-11-13T14:02:11.408Z off-all: disabled.json +desktop.blender  ->  claude_desktop_config.json -mcpServers.blender
2026-11-14T13:55:40.112Z off-all: nothing to change
```

After you sign in, the last line should have that day's date (in UTC). "nothing
to change" means everything was already off. To see that the task is
registered and when it last ran:

```powershell
Get-ScheduledTask 'mcp-toggle off-all at log on' | Get-ScheduledTaskInfo
```

`LastRunTime` shows the task started, but `LastTaskResult` stays 0 even when
`off-all` failed, since the task runs it through `conhost`, which doesn't pass
the exit code on. The log is the record of what happened.

## Troubleshooting

**No new log line after signing in.** The reset didn't run. Check that the
task exists with the command above; if it doesn't, run `install.ps1` again. If
the installer used the Startup folder instead, look for
`mcp-toggle off-all.lnk` in `shell:startup`.

**`can't read config` in the log.** The file isn't valid JSON, often because an
app was writing it at the same moment. Run `node mcp-toggle.mjs off-all` once
the app has finished starting; it only touches servers that are still on.

**`disabled.json was damaged ... moved to disabled.json.corrupt-...` in the
log.** `disabled.json` couldn't be read as a list of parked servers (often a
write cut short), so `off-all` set it aside and started a new one before
switching everything off. Servers that were parked in the old file no longer
show in the list. To get one back, copy its entry from the `.corrupt-` file into
the app's `mcpServers`; it then shows as on.

**`... failed: EPERM` or `EBUSY` in the log.** Another program had the file
locked, or it's read-only. Everything else was still switched off. Fix the file
and run `off-all` again.

**A server is still running after sign-in.** Its app probably opened before the
reset. Quit the app (for Claude Desktop, from the tray), check `list` shows the
server off, and reopen it. Then take the app out of Settings > Apps > Startup,
and run `install.ps1 -CheckStartup` to confirm nothing else opens it.

**A server is missing from the list.** It's one of the kinds the switchboard
doesn't see (see [What the reset covers](#what-the-reset-covers)), or the app's
config is somewhere else. `list` shows `config file not found` for an app whose
file isn't where the table above says.

## Tests

```powershell
node --test
```

The tests work on temp files only; they never read or change your configs.

## How it was built

I built this with Claude as a pair programmer. I designed how it works, wrote parts of the code, directed the rest, and reviewed every change through pull requests.
