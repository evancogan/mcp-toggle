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
const BOM = '\uFEFF';

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
    data: JSON.parse(text.startsWith(BOM) ? text.slice(1) : text),
    bom: text.startsWith(BOM),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    finalEol: /\n$/.test(text),
  };
}

// Names the file in a read error, the way a failed save is named.
function readNamed(file, read) {
  try {
    return read(file);
  } catch (e) {
    e.message = `${path.basename(file)} read failed: ${e.message}`;
    throw e;
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// On Windows a virus scanner or indexer can hold a just-written file for a
// moment, which makes the rename fail; try again for about a second.
function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      pause(100);
    }
  }
}

// Written to a temp file beside the target and renamed over it, so a crash or
// power cut mid-write leaves the old file whole rather than cut short.
function writeJson(file, doc) {
  let text = JSON.stringify(doc.data, null, 2);
  if (doc.eol !== '\n') text = text.replaceAll('\n', doc.eol);
  const content = (doc.bom ? BOM : '') + text + (doc.finalEol ? doc.eol : '');
  let target = file;
  try {
    target = fs.realpathSync(file); // write through a symlink, not over it
  } catch {}
  const temp = `${target}.mcp-toggle-${process.pid}.tmp`;
  try {
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameRetrying(temp, target);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A stash that can't be parsed, or isn't shaped like one, is marked corrupt
// (as opposed to unreadable, say because another program has it locked).
function readStash(file) {
  let stash;
  try {
    stash = readJson(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { data: {}, bom: false, eol: '\n', finalEol: true };
    if (e instanceof SyntaxError) e.corrupt = true;
    throw e;
  }
  if (!isMap(stash.data) || !Object.values(stash.data).every(isMap)) {
    throw Object.assign(new Error('not a list of parked servers'), { corrupt: true });
  }
  return stash;
}

function saveStash(file, stash) {
  for (const [id, parked] of Object.entries(stash.data)) {
    if (!Object.keys(parked).length) delete stash.data[id];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, stash);
}

// A corrupt stash would stop every server from being switched off. Move it
// aside, keeping whatever was parked in it, so a new one can start. Returns
// the move as a write record, or nothing if the stash was fine.
function setAsideCorruptStash(stashFile) {
  let reason;
  try {
    readStash(stashFile);
    return [];
  } catch (e) {
    if (!e.corrupt) {
      e.message = `${path.basename(stashFile)} read failed: ${e.message}`;
      throw e;
    }
    reason = e.message;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let aside = `${stashFile}.corrupt-${stamp}`;
  for (let n = 2; fs.existsSync(aside); n++) aside = `${stashFile}.corrupt-${stamp}-${n}`;
  try {
    renameRetrying(stashFile, aside);
  } catch (e) {
    e.message = `${path.basename(stashFile)} is damaged (${reason}) and couldn't be moved aside: ${e.message}`;
    throw e;
  }
  return [{ file: stashFile, change: `was damaged (${reason}); moved to ${path.basename(aside)}` }];
}

export function listServers(apps = APPS, stashFile = STASH) {
  const stash = readNamed(stashFile, readStash).data;
  return apps.map((app) => {
    let live;
    try {
      live = readJson(app.file).data.mcpServers ?? {};
    } catch (e) {
      const missing = e.code === 'ENOENT';
      const error = missing ? 'config file not found' : `can't read config: ${e.message}`;
      return { ...app, error, missing, servers: [] };
    }
    const parked = stash[app.id] ?? {};
    // Sorted so a server keeps its row when it moves between the config and the stash.
    const names = [...new Set([...Object.keys(live), ...Object.keys(parked)])].sort((a, b) => a.localeCompare(b));
    const servers = names.map((name) => ({
      name,
      on: Object.hasOwn(live, name),
      entry: live[name] ?? parked[name],
    }));
    return { ...app, error: null, missing: false, servers };
  });
}

// Records each finished write as { file, change }. If a write fails, its
// error is prefixed with the file and change, and carries the writes that
// completed before it as e.writes.
function writeRecorder(stashFile) {
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
  return { writes, save };
}

// An entry is written to its new home before it's removed from the old one,
// so a failed write can leave it in both places but never in neither.
// Returns the writes made, in order, as { file, change }.
export function setServer(app, name, on, stashFile = STASH) {
  const config = readNamed(app.file, readJson);
  const live = (config.data.mcpServers ??= {});
  const stash = readNamed(stashFile, readStash);
  const parked = (stash.data[app.id] ??= {});
  const isLive = Object.hasOwn(live, name);
  const isParked = Object.hasOwn(parked, name);
  if (!isLive && !isParked) throw new Error(`${app.label} has no MCP server named "${name}"`);

  const { writes, save } = writeRecorder(stashFile);
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

// Switches off every server that is on in one app: one stash write parks them
// all, then one config write removes them, so the same rule holds as in
// setServer. Reads the config afresh, so a server the app added since
// listServers is caught too.
function parkAll(app, stashFile) {
  const config = readNamed(app.file, readJson);
  const live = config.data.mcpServers ?? {};
  const names = Object.keys(live);
  if (!names.length) return [];
  const stash = readNamed(stashFile, readStash);
  const parked = (stash.data[app.id] ??= {});

  const { writes, save } = writeRecorder(stashFile);
  for (const name of names) parked[name] = live[name];
  save(stashFile, stash, names.map((name) => `+${app.id}.${name}`).join(' '));
  for (const name of names) delete live[name];
  save(app.file, config, names.map((name) => `-mcpServers.${name}`).join(' '));
  return writes;
}

// Keeps going past a failure so one bad file can't leave the other apps' servers
// on. A config that exists but can't be read counts as a failure, since its
// servers may still be on; a missing config just means the app isn't installed.
// A corrupt stash is moved aside first. If anything failed, the error lists
// every failure and carries all completed writes as e.writes.
export function allOff(apps = APPS, stashFile = STASH) {
  const writes = setAsideCorruptStash(stashFile);
  const failures = [];
  for (const app of listServers(apps, stashFile)) {
    if (app.missing) continue;
    if (app.error) {
      failures.push(`${app.label}: ${app.error}`);
      continue;
    }
    if (!app.servers.some((s) => s.on)) continue;
    try {
      writes.push(...parkAll(app, stashFile));
    } catch (e) {
      writes.push(...(e.writes ?? []));
      failures.push(`${app.label}: ${e.message}`);
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
