// Run with: node --test
//
// Every test works on files in a temp folder. The home and app-data folders
// are pointed there before mcp-toggle.mjs loads, so even its default paths
// (the real configs and stash) can't be touched.

import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-toggle-test-'));
const sandboxEnv = (home) => ({
  USERPROFILE: home,
  HOME: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
});
Object.assign(process.env, sandboxEnv(path.join(sandbox, 'home')));

const { allOff, setServer, listServers, describeWrites, APPS, STASH } = await import('./mcp-toggle.mjs');
const SCRIPT = fileURLToPath(new URL('./mcp-toggle.mjs', import.meta.url));

test('default paths point into the sandbox', () => {
  for (const file of [STASH, ...APPS.map((a) => a.file)]) assert.ok(file.startsWith(sandbox), file);
});

let dir;
let stash;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(sandbox, 'case-'));
  stash = path.join(dir, 'stash', 'disabled.json');
});
afterEach(() => {
  // Clear read-only flags so the folder can be removed.
  for (const name of fs.readdirSync(dir, { recursive: true })) fs.chmodSync(path.join(dir, name), 0o666);
  fs.rmSync(dir, { recursive: true, force: true });
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const json = (data) => JSON.stringify(data, null, 2) + '\n';
const readData = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const tempFiles = () => fs.readdirSync(dir, { recursive: true }).filter((name) => name.endsWith('.tmp'));

// An app whose config holds `contents` (a string), or no config if undefined.
function app(id, contents) {
  const file = path.join(dir, `${id}.json`);
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return { id, label: `App ${id}`, file };
}

const server = (name) => ({ command: 'node', args: [`${name}.js`] });

// Runs fn, which must throw, and returns what it threw.
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
}

test('allOff parks every server with one stash write and one config write per app', () => {
  const a = app('a', json({ theme: 'dark', mcpServers: { one: server('one'), two: server('two') } }));
  const b = app('b', json({ mcpServers: { three: server('three') } }));
  const writes = allOff([a, b], stash);

  assert.deepEqual(
    writes.map((w) => [path.basename(w.file), w.change]),
    [
      ['disabled.json', '+a.one +a.two'],
      ['a.json', '-mcpServers.one -mcpServers.two'],
      ['disabled.json', '+b.three'],
      ['b.json', '-mcpServers.three'],
    ],
  );
  assert.deepEqual(readData(a.file), { theme: 'dark', mcpServers: {} });
  assert.deepEqual(readData(b.file), { mcpServers: {} });
  assert.deepEqual(readData(stash), {
    a: { one: server('one'), two: server('two') },
    b: { three: server('three') },
  });
  assert.deepEqual(tempFiles(), []);
});

test('allOff with everything already off changes nothing', () => {
  const a = app('a', json({ mcpServers: {} }));
  const b = app('b', json({ other: true }));
  assert.equal(describeWrites(allOff([a, b], stash)), 'nothing to change');
  assert.equal(fs.existsSync(stash), false);
});

test('a write keeps the BOM, CRLF line endings and missing final newline', () => {
  const text = '﻿' + JSON.stringify({ x: 1, mcpServers: { one: server('one') } }, null, 2).replaceAll('\n', '\r\n');
  const a = app('a', text);
  setServer(a, 'one', false, stash);
  const expected = '﻿' + JSON.stringify({ x: 1, mcpServers: {} }, null, 2).replaceAll('\n', '\r\n');
  assert.equal(fs.readFileSync(a.file, 'utf8'), expected);
});

test('setServer switches a server off and back on', () => {
  const a = app('a', json({ mcpServers: { one: server('one') } }));
  assert.equal(describeWrites(setServer(a, 'one', false, stash)), 'disabled.json +a.one  ->  a.json -mcpServers.one');
  assert.deepEqual(listServers([a], stash)[0].servers.map((s) => [s.name, s.on]), [['one', false]]);
  assert.equal(describeWrites(setServer(a, 'one', true, stash)), 'a.json +mcpServers.one  ->  disabled.json -a.one');
  assert.deepEqual(readData(a.file), { mcpServers: { one: server('one') } });
  assert.deepEqual(readData(stash), {});
});

test('setServer names the file when a read fails', () => {
  const broken = app('a', '{"mcpServers": {');
  assert.match(thrown(() => setServer(broken, 'one', false, stash)).message, /^a\.json read failed: /);

  const ok = app('b', json({ mcpServers: { one: server('one') } }));
  fs.mkdirSync(path.dirname(stash), { recursive: true });
  fs.writeFileSync(stash, '{"b": ');
  assert.match(thrown(() => setServer(ok, 'one', false, stash)).message, /^disabled\.json read failed: /);
});

test('listServers marks a missing config with missing: true', () => {
  const [missing, present] = listServers([app('gone'), app('here', json({}))], stash);
  assert.equal(missing.missing, true);
  assert.equal(present.missing, false);
});

test('a missing config is not a failure', () => {
  const ok = app('ok', json({ mcpServers: { one: server('one') } }));
  allOff([app('gone'), ok], stash);
  assert.deepEqual(readData(ok.file), { mcpServers: {} });
});

test('a broken config is a failure, and the other apps are still switched off', () => {
  const broken = app('broken', '{"mcpServers": {"one": ');
  const ok = app('ok', json({ mcpServers: { two: server('two') } }));
  const err = thrown(() => allOff([broken, ok], stash));
  assert.match(err.message, /^App broken: can't read config: /);

  assert.deepEqual(readData(ok.file), { mcpServers: {} });
  assert.deepEqual(readData(stash), { ok: { two: server('two') } });
  assert.equal(fs.readFileSync(broken.file, 'utf8'), '{"mcpServers": {"one": ');
  assert.equal(err.writes.length, 2);
});

test('a read-only config is a failure; its server is parked but never lost', () => {
  const original = json({ mcpServers: { one: server('one') } });
  const locked = app('locked', original);
  fs.chmodSync(locked.file, 0o444);
  const ok = app('ok', json({ mcpServers: { two: server('two') } }));

  const err = thrown(() => allOff([locked, ok], stash));
  assert.match(err.message, /^App locked: locked\.json -mcpServers\.one failed: E(PERM|ACCES)/);

  // Parked first, then the config write failed: it's in both places.
  assert.equal(fs.readFileSync(locked.file, 'utf8'), original);
  assert.deepEqual(readData(stash), { locked: { one: server('one') }, ok: { two: server('two') } });
  assert.deepEqual(readData(ok.file), { mcpServers: {} });
  assert.match(describeWrites(err.writes), /disabled\.json \+locked\.one  ->  disabled\.json \+ok\.two  ->  ok\.json/);
  assert.deepEqual(tempFiles(), []);
});

for (const [kind, contents] of [
  ['cut short', '{"a": {"one": {"command": "no'],
  ['empty', ''],
  ['not an object', '[]'],
  ['holding a non-object', '{"a": 5}'],
]) {
  test(`a corrupt disabled.json (${kind}) is moved aside and servers are still switched off`, () => {
    fs.mkdirSync(path.dirname(stash), { recursive: true });
    fs.writeFileSync(stash, contents);
    const ok = app('ok', json({ mcpServers: { two: server('two') } }));

    const writes = allOff([ok], stash);

    assert.match(writes[0].change, /^was damaged \(.+\); moved to disabled\.json\.corrupt-[\dT-]+Z$/);
    const aside = fs.readdirSync(path.dirname(stash)).filter((name) => name.startsWith('disabled.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(stash), aside[0]), 'utf8'), contents);
    assert.deepEqual(readData(stash), { ok: { two: server('two') } });
    assert.deepEqual(readData(ok.file), { mcpServers: {} });
  });
}

test('with every kind of failure at once, the normal config is still switched off', () => {
  fs.mkdirSync(path.dirname(stash), { recursive: true });
  fs.writeFileSync(stash, '{"x": {');
  const broken = app('broken', 'not json');
  const locked = app('locked', json({ mcpServers: { one: server('one') } }));
  fs.chmodSync(locked.file, 0o444);
  const ok = app('ok', json({ keep: 1, mcpServers: { two: server('two'), three: server('three') } }));

  const err = thrown(() => allOff([broken, app('gone'), locked, ok], stash));

  const failures = err.message.split('; ');
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^App broken: can't read config: /);
  assert.match(failures[1], /^App locked: locked\.json -mcpServers\.one failed: /);
  assert.deepEqual(readData(ok.file), { keep: 1, mcpServers: {} });
  assert.deepEqual(readData(stash), {
    locked: { one: server('one') },
    ok: { two: server('two'), three: server('three') },
  });
  assert.match(describeWrites(err.writes), /^disabled\.json was damaged/);
});

test('off-all from the command line logs what it did and exits 1 on a failure', () => {
  const home = path.join(dir, 'home');
  const env = sandboxEnv(home);
  const desktop = path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, '{');
  fs.writeFileSync(path.join(home, '.claude.json'), json({ mcpServers: { one: server('one') } }));
  // No ~/.lmstudio/mcp.json: LM Studio isn't installed.

  const run = spawnSync(process.execPath, [SCRIPT, 'off-all'], { env: { ...process.env, ...env }, encoding: 'utf8' });

  assert.equal(run.status, 1, run.stderr);
  const log = fs.readFileSync(path.join(home, '.mcp-toggle', 'off-all.log'), 'utf8');
  assert.match(
    log,
    /^\S+Z off-all: disabled\.json \+code\.one  ->  \.claude\.json -mcpServers\.one  ->  failed: Claude Desktop \(chat \+ Code tab\): can't read config: /,
  );
  assert.doesNotMatch(log, /LM Studio/);
  assert.deepEqual(readData(path.join(home, '.claude.json')), { mcpServers: {} });
});
