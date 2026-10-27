# mcp-toggle

One list for switching MCP servers on and off across Claude Desktop, Claude Code
and LM Studio on Windows. Every server is switched off at login, so nothing runs
until you turn it on.

## Setup

Needs Node.js 20 or later.

```powershell
gh repo clone evancogan/mcp-toggle C:\Repos\mcp-toggle
powershell -ExecutionPolicy Bypass -File C:\Repos\mcp-toggle\install.ps1
```

This adds an **MCP Servers** shortcut to the desktop and a login reset: a
scheduled task, `mcp-toggle off-all at log on`, that runs `off-all` with no
window each time you sign in. If Windows won't register the task without admin
rights, the installer puts a shortcut in the Startup folder instead, which
Windows runs a few seconds later in sign-in. `install.ps1 -Uninstall` removes
both.

## Use

Open the shortcut: ↑/↓ to move, Space to switch a server on or off. The bottom
line shows the file writes each switch made. Restart the app for a change to
take effect.

| Command | |
|---|---|
| `node mcp-toggle.mjs` | interactive list |
| `node mcp-toggle.mjs list` | every server and its state |
| `node mcp-toggle.mjs on\|off desktop\|code\|lmstudio <name>` | switch one server |
| `node mcp-toggle.mjs off-all` | switch everything off (what the login entry runs) |

## How it works

Switching a server off moves its entry from the app's config into
`~/.mcp-toggle/disabled.json`; switching it on moves it back. The rest of each
config file is left byte-for-byte as it was. Each `off-all` run, including the
one at login, adds a line to `~/.mcp-toggle/off-all.log`.

| App | Config |
|---|---|
| Claude Desktop | `%LOCALAPPDATA%\Claude-Data\claude_*\claude_desktop_config.json` (Store build) or `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude.json` (user-scope servers) |
| LM Studio / Bionic | `~/.lmstudio/mcp.json` |
