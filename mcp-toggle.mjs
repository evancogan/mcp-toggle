// MCP switchboard: turn MCP servers on and off for Claude Desktop, Claude Code
// and LM Studio from one list.
//
// Turning a server off moves its entry out of the app's config into
// ~/.mcp-toggle/disabled.json; turning it on moves it back. Apps only read
// their config at startup, so a change applies after the app restarts.
//
//   node mcp-toggle.mjs                      interactive list
//   node mcp-toggle.mjs list                 print every server and its state
//   node mcp-toggle.mjs on|off <app> <name>  app is desktop, code or lmstudio
//   node mcp-toggle.mjs off-all              switch every server off (run at login)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const SCRIPT = fileURLToPath(import.meta.url);
export const STASH = path.join(HOME, '.mcp-toggle', 'disabled.json');
const OFF_ALL_LOG = path.join(HOME, '.mcp-toggle', 'off-all.log');

// The Store build of Claude keeps its config under %LOCALAPPDATA%\Claude-Data\claude_<id>;
// the classic installer uses %APPDATA%\Claude.
function desktopConfigPath() {
  const dataRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
  try {
    for (const dir of fs.readdirSync(dataRoot)) {
      const file = path.join(dataRoot, dir, 'claude_desktop_config.json');
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
}

export const APPS = [
  {
    id: 'desktop',
    label: 'Claude Desktop (chat + Code tab)',
    file: desktopConfigPath(),
    restart: 'quit Claude from the tray and reopen it to apply',
  },
  {
    id: 'code',
    label: 'Claude Code (all projects)',
    file: path.join(HOME, '.claude.json'),
    restart: 'new Claude Code sessions will pick it up',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio / Bionic',
    file: path.join(HOME, '.lmstudio', 'mcp.json'),
    restart: 'restart LM Studio and Bionic to apply',
  },
];

// Keep each file's BOM, line endings and final newline so a toggle only
// changes the mcpServers block.
function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return {
    data: JSON.parse(text.replace(/^﻿/, '')),
    bom: text.startsWith('﻿'),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    finalEol: /\n$/.test(text),
  };
}

function writeJson(file, doc) {
  let text = JSON.stringify(doc.data, null, 2);
  if (doc.eol !== '\n') text = text.replaceAll('\n', doc.eol);
  fs.writeFileSync(file, (doc.bom ? '﻿' : '') + text + (doc.finalEol ? doc.eol : ''));
}

function readStash(file) {
  try {
    return readJson(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { data: {}, bom: false, eol: '\n', finalEol: true };
    throw e;
  }
}

function saveStash(file, stash) {
  for (const [id, parked] of Object.entries(stash.data)) {
    if (!Object.keys(parked).length) delete stash.data[id];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, stash);
}

export function listServers(apps = APPS, stashFile = STASH) {
  const stash = readStash(stashFile).data;
  return apps.map((app) => {
    let live;
    try {
      live = readJson(app.file).data.mcpServers ?? {};
    } catch (e) {
      const error = e.code === 'ENOENT' ? 'config file not found' : `can't read config: ${e.message}`;
      return { ...app, error, servers: [] };
    }
    const parked = stash[app.id] ?? {};
    // Sorted so a server keeps its row when it moves between the config and the stash.
    const names = [...new Set([...Object.keys(live), ...Object.keys(parked)])].sort((a, b) => a.localeCompare(b));
    const servers = names.map((name) => ({
      name,
      on: Object.hasOwn(live, name),
      entry: live[name] ?? parked[name],
    }));
    return { ...app, error: null, servers };
  });
}

// An entry is written to its new home before it's removed from the old one,
// so a failed write can leave it in both places but never in neither.
// Returns the writes made, in order, as { file, change }. A write is recorded
// only once it has finished; if one fails, the error carries the writes that
// completed before it as e.writes.
export function setServer(app, name, on, stashFile = STASH) {
  const config = readJson(app.file);
  const live = (config.data.mcpServers ??= {});
  const stash = readStash(stashFile);
  const parked = (stash.data[app.id] ??= {});
  const isLive = Object.hasOwn(live, name);
  const isParked = Object.hasOwn(parked, name);
  if (!isLive && !isParked) throw new Error(`${app.label} has no MCP server named "${name}"`);

  const writes = [];
  const save = (file, doc, change) => {
    try {
      (file === stashFile ? saveStash : writeJson)(file, doc);
    } catch (e) {
      e.writes = writes;
      e.message = `${path.basename(file)} ${change} failed: ${e.message}`;
      throw e;
    }
    writes.push({ file, change });
  };
  if (on && !isLive) {
    live[name] = parked[name];
    save(app.file, config, `+mcpServers.${name}`);
  }
  if (on && isParked) {
    delete parked[name];
    save(stashFile, stash, `-${app.id}.${name}`);
  }
  if (!on && isLive) {
    parked[name] = live[name];
    save(stashFile, stash, `+${app.id}.${name}`);
    delete live[name];
    save(app.file, config, `-mcpServers.${name}`);
  }
  return writes;
}

// Keeps going past a failure so one bad file can't leave the other apps' servers
// on. A config that exists but can't be read counts as a failure, since its
// servers may still be on; a missing config just means the app isn't installed.
// If anything failed, the error lists every failure and carries all completed
// writes as e.writes.
export function allOff(apps = APPS, stashFile = STASH) {
  const writes = [];
  const failures = [];
  for (const app of listServers(apps, stashFile)) {
    if (app.error && app.error !== 'config file not found') failures.push(`${app.label}: ${app.error}`);
    for (const server of app.servers.filter((s) => s.on)) {
      try {
        writes.push(...setServer(app, server.name, false, stashFile));
      } catch (e) {
        writes.push(...(e.writes ?? []));
        failures.push(e.message);
      }
    }
  }
  if (failures.length) {
    const e = new Error(failures.join('; '));
    e.writes = writes;
    throw e;
  }
  return writes;
}

const style = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = style(1);
const dim = style(2);
const red = style(31);
const green = style(32);
const yellow = style(33);
const cyan = style(36);

function describe(entry = {}) {
  if (entry.url) return entry.url;
  const command = path.basename(entry.command ?? '').replace(/\.(exe|cmd)$/i, '');
  return [command, ...(entry.args ?? [])].join(' ');
}

function tildify(file) {
  return file.toLowerCase().startsWith(HOME.toLowerCase()) ? '~' + file.slice(HOME.length) : file;
}

function fit(text, width) {
  return text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;
}

export const describeWrites = (writes) =>
  writes.length ? writes.map((w) => `${path.basename(w.file)} ${w.change}`).join('  ->  ') : 'nothing to change';

// What a failed switch actually wrote before the error.
const describeFailure = (e) => `${e.writes?.length ? describeWrites(e.writes) + '  ->  ' : ''}failed`;

const rowsOf = (groups) => groups.flatMap((app) => app.servers.map((server) => ({ app, server })));

export function render(groups, cursor, message, fileLine, width = 100) {
  const nameWidth = Math.max(8, ...rowsOf(groups).map((r) => r.server.name.length));
  const lines = [bold(' MCP servers'), ''];
  let row = 0;
  for (const app of groups) {
    lines.push(` ${bold(app.label)}  ${dim(fit(tildify(app.file), width - app.label.length - 4))}`);
    if (app.error) lines.push(`   ${red(app.error)}`);
    else if (!app.servers.length) lines.push(dim('   no servers configured'));
    for (const server of app.servers) {
      const selected = row++ === cursor;
      const state = server.on ? green('● on ') : dim('○ off');
      const name = server.name.padEnd(nameWidth);
      const detail = fit(describe(server.entry), width - nameWidth - 13);
      lines.push(`${selected ? cyan(' ›') : '  '} ${state}  ${selected ? bold(name) : name}  ${dim(detail)}`);
    }
    lines.push('');
  }
  lines.push(
    message,
    fileLine ? dim(fit(` file: ${fileLine}`, width - 1)) : '',
    '',
    dim(' ↑/↓ move · space toggle · r reload · q quit'),
  );
  return lines.join('\n');
}

function runInteractive() {
  if (!process.stdin.isTTY) {
    console.error('Run this in a terminal, or use: node mcp-toggle.mjs list');
    process.exit(1);
  }
  let groups = listServers();
  let cursor = 0;
  let message = '';
  let fileLine = '';

  const draw = () => {
    cursor = Math.min(Math.max(cursor, 0), Math.max(rowsOf(groups).length - 1, 0));
    const width = process.stdout.columns || 100;
    process.stdout.write('\x1b[H\x1b[2J' + render(groups, cursor, message, fileLine, width));
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write('\x1b]0;MCP servers\x07\x1b[?1049h\x1b[?25l');
  process.on('exit', () => process.stdout.write('\x1b[?25h\x1b[?1049l'));
  process.stdout.on('resize', draw);

  process.stdin.on('keypress', (_, key = {}) => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) process.exit(0);
    const selected = rowsOf(groups)[cursor];
    if (key.name === 'up' || key.name === 'k') cursor--;
    else if (key.name === 'down' || key.name === 'j') cursor++;
    else if (key.name === 'r') {
      groups = listServers();
      message = dim(' Reloaded.');
    } else if ((key.name === 'space' || key.name === 'return') && selected) {
      const { app, server } = selected;
      try {
        fileLine = describeWrites(setServer(app, server.name, !server.on));
        message = server.on
          ? yellow(` ${server.name} is off for ${app.label}; ${app.restart}.`)
          : green(` ${server.name} is on for ${app.label}; ${app.restart}.`);
      } catch (e) {
        fileLine = describeFailure(e);
        message = red(` ${e.message}`);
      }
      groups = listServers();
    } else return;
    draw();
  });
  draw();
}

function main([command, ...args]) {
  if (!command) return runInteractive();
  if (command === 'list') {
    for (const app of listServers()) {
      if (app.error) console.log(`${app.id}\t${app.error}`);
      for (const server of app.servers) console.log(`${app.id}\t${server.on ? 'on' : 'off'}\t${server.name}`);
    }
    return;
  }
  if (command === 'off-all') {
    // Also logged to a file, since at login there's no console to read.
    let result;
    try {
      result = describeWrites(allOff());
    } catch (e) {
      result = `${describeFailure(e)}: ${e.message}`;
      process.exitCode = 1;
    }
    const line = `${new Date().toISOString()} off-all: ${result}`;
    console.log(line);
    fs.mkdirSync(path.dirname(OFF_ALL_LOG), { recursive: true });
    fs.appendFileSync(OFF_ALL_LOG, line + os.EOL);
    return;
  }
  const app = APPS.find((a) => a.id === args[0]);
  if ((command === 'on' || command === 'off') && app && args[1]) {
    try {
      const writes = setServer(app, args[1], command === 'on');
      console.log(`${args[1]} is ${command} for ${app.label}; ${app.restart}.`);
      console.log(`file: ${describeWrites(writes)}`);
    } catch (e) {
      console.error(e.message);
      console.error(`file: ${describeFailure(e)}`);
      process.exitCode = 1;
    }
    return;
  }
  console.error('usage: node mcp-toggle.mjs [list | off-all | on|off desktop|code|lmstudio <name>]');
  process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '').toLowerCase() === SCRIPT.toLowerCase()) main(process.argv.slice(2));
