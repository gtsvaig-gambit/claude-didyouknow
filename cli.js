#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
let S;
try {
  S = require('./safe');
} catch (e) {
  console.error(`
Cannot load safe.js -- this package is incomplete.

Expected these files next to cli.js:
  safe.js  statusline.js  hook.js  generate.js

If you assembled the repo by hand, make sure all of them are committed at the
repository root (not in a subdirectory).
`);
  process.exit(1);
}

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const ROOT = path.join(CLAUDE, 'didyouknow');
const BIN = path.join(ROOT, 'bin');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const CONFIG = path.join(ROOT, 'config.json');

const RUNTIME = ['statusline.js', 'hook.js', 'generate.js', 'safe.js'];
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd'];

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

const ok = (s) => console.log(`  ${c.g('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.y('!')} ${s}`);
const fail = (s) => console.log(`  ${c.r('✗')} ${s}`);

function readJson(file, fallback) {
  return S.readJsonFile(file, fallback);
}

// A symlinked settings.json would make our write land somewhere unexpected.
function assertRegularFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`${file} is not a regular file -- refusing to write`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// Atomic: a crash mid-write must not leave a truncated settings.json.
function saveSettings(obj) {
  assertRegularFile(SETTINGS);
  S.writeFileAtomic(SETTINGS, JSON.stringify(obj, null, 2), 0o600);
}

function statuslineCmd() {
  // Absolute path, and pointed at the *installed* copy -- never the npx cache,
  // which is temporary and would break on the next npm cache prune.
  return `${process.execPath} ${path.join(BIN, 'statusline.js')}`;
}

function hookCmd() {
  return `${process.execPath} ${path.join(BIN, 'hook.js')}`;
}

function isOurs(cmd) {
  return typeof cmd === 'string' && cmd.includes(path.join('didyouknow', 'bin'));
}

// ---------------------------------------------------------------- install

function install() {
  console.log(`\n${c.b('didyouknow')} ${c.d('· installing')}\n`);

  // Verify the package is complete before mutating anything. A half-shipped
  // package must not leave settings.json pointing at files that do not exist.
  const missing = RUNTIME.filter((f) => !fs.existsSync(path.join(__dirname, f)));
  if (missing.length) {
    fail(`package incomplete, missing: ${missing.join(', ')}`);
    console.log(`\n  All runtime files must sit next to cli.js at the repository root.\n`);
    process.exit(1);
  }

  // Owner-only: cached fact sets reveal what you have been working on, and a
  // writable dir would let another local user swap out the runtime scripts.
  S.mkdirSecure(ROOT);
  S.mkdirSecure(BIN);
  S.mkdirSecure(path.join(ROOT, 'cache'));

  for (const f of RUNTIME) {
    const src = path.join(__dirname, f);
    const dst = path.join(BIN, f);
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, 0o700); } catch {}
  }
  ok(`runtime installed to ${c.d(BIN.replace(HOME, '~'))}`);

  assertRegularFile(SETTINGS);
  const settings = readJson(SETTINGS, {});
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.bak.${Date.now()}`;
    fs.copyFileSync(SETTINGS, backup);
    ok(`backed up settings.json to ${c.d(path.basename(backup))}`);
  }

  // Preserve whatever status line they already had: keep it as the top row
  // instead of silently replacing it.
  const config = readJson(CONFIG, {});
  const existing = settings.statusLine;
  if (existing && existing.type === 'command' && !isOurs(existing.command)) {
    config.baseCommand = existing.command;
    ok(`kept your existing status line as the top row`);
  }
  config.secondsPerFact = config.secondsPerFact || 12;
  config.model = config.model || 'haiku';
  config.minPromptLength = config.minPromptLength || 15;
  S.writeFileAtomic(CONFIG, JSON.stringify(config, null, 2), 0o600);

  settings.statusLine = {
    type: 'command',
    command: statuslineCmd(),
    refreshInterval: 10,
  };
  ok('statusLine configured (refreshInterval 10s)');

  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const ev of HOOK_EVENTS) {
    const groups = settings.hooks[ev] || [];
    const present = groups.some((g) =>
      (g.hooks || []).some((h) => isOurs(h.command))
    );
    if (present) continue;
    groups.push({
      hooks: [{ type: 'command', command: hookCmd(), timeout: 5 }],
    });
    settings.hooks[ev] = groups;
    added++;
  }
  ok(added ? `registered ${added} hook(s): ${HOOK_EVENTS.join(', ')}` : 'hooks already registered');

  saveSettings(settings);

  smoke();

  console.log(`\n${c.b('Done.')} Restart Claude Code, then ask it to build something.\n`);
  console.log(c.d('  configure   ~/.claude/didyouknow/config.json'));
  const self = process.env.DYK_INVOKED_AS || 'npx github:you/claude-didyouknow';
  console.log(c.d(`  diagnose    ${self} doctor`));
  console.log(c.d(`  remove      ${self} uninstall\n`));
}

// ---------------------------------------------------------------- verify

function smoke() {
  const { execFileSync } = require('child_process');
  const mock = JSON.stringify({
    session_id: '__smoke__',
    model: { display_name: 'Opus' },
    workspace: { current_dir: process.cwd() },
    context_window: { used_percentage: 20 },
  });
  try {
    const out = execFileSync(process.execPath, [path.join(BIN, 'statusline.js')], {
      input: mock,
      encoding: 'utf8',
      env: { ...process.env, COLUMNS: '100' },
      timeout: 5000,
    });
    if (out.trim()) ok('status line renders');
    else warn('status line produced no output');
  } catch (e) {
    fail(`status line failed: ${e.message}`);
  }

  try {
    const out = execFileSync(process.execPath, [path.join(BIN, 'hook.js')], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: '__smoke__' }),
      encoding: 'utf8',
      timeout: 5000,
    });
    // A hook that prints to stdout on UserPromptSubmit would inject text into
    // Claude's context. Silence is the contract.
    if (out.length === 0) ok('hooks are silent on stdout');
    else fail(`hook printed ${out.length} bytes to stdout -- would pollute context`);
  } catch (e) {
    fail(`hook failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- doctor

function doctor() {
  console.log(`\n${c.b('didyouknow')} ${c.d('· doctor')}\n`);

  RUNTIME.every((f) => fs.existsSync(path.join(BIN, f)))
    ? ok('runtime files present')
    : fail('runtime files missing -- run install');

  const settings = readJson(SETTINGS, {});
  isOurs(settings.statusLine && settings.statusLine.command)
    ? ok('statusLine points at didyouknow')
    : fail('statusLine not configured');

  settings.statusLine && settings.statusLine.refreshInterval
    ? ok(`refreshInterval = ${settings.statusLine.refreshInterval}s`)
    : warn('no refreshInterval -- facts will not rotate while Claude works');

  for (const ev of HOOK_EVENTS) {
    const groups = (settings.hooks || {})[ev] || [];
    groups.some((g) => (g.hooks || []).some((h) => isOurs(h.command)))
      ? ok(`${ev} hook registered`)
      : fail(`${ev} hook missing`);
  }

  if (settings.disableAllHooks) fail('disableAllHooks is set -- nothing will run');

  for (const [label, dir] of [['data dir', ROOT], ['cache dir', path.join(ROOT, 'cache')]]) {
    try {
      const m = fs.statSync(dir).mode & 0o777;
      m & 0o077 ? fail(`${label} is ${m.toString(8)} -- should be 700`) : ok(`${label} is owner-only`);
    } catch { fail(`${label} missing`); }
  }

  if (readJson(CONFIG, {}).baseCommand) {
    S.configIsTrustworthy(CONFIG)
      ? ok('config.json ownership/permissions trusted for baseCommand')
      : fail('config.json is writable by others -- baseCommand will be ignored');
  }

  const { execFileSync } = require('child_process');
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 8000 });
    ok('claude CLI on PATH (needed to generate facts)');
  } catch {
    fail('claude CLI not on PATH -- no facts can be generated');
  }

  let n = 0;
  try {
    n = fs.readdirSync(path.join(ROOT, 'cache')).filter((f) => f.endsWith('.json')).length;
  } catch {}
  ok(`${n} cached fact set(s)`);

  const log = path.join(ROOT, 'generate.log');
  if (fs.existsSync(log) && fs.statSync(log).size > 0) {
    warn(`generate.log is non-empty:`);
    console.log(c.d(fs.readFileSync(log, 'utf8').trim().split('\n').slice(-6).map((l) => `      ${l}`).join('\n')));
  }

  smoke();
  console.log('');
}

// ---------------------------------------------------------------- uninstall

function uninstall() {
  console.log(`\n${c.b('didyouknow')} ${c.d('· uninstalling')}\n`);

  assertRegularFile(SETTINGS);
  const settings = readJson(SETTINGS, {});
  if (fs.existsSync(SETTINGS)) {
    fs.copyFileSync(SETTINGS, `${SETTINGS}.bak.${Date.now()}`);
  }

  const config = readJson(CONFIG, {});
  if (isOurs(settings.statusLine && settings.statusLine.command)) {
    if (config.baseCommand) {
      settings.statusLine = { type: 'command', command: config.baseCommand };
      ok('restored your previous status line');
    } else {
      delete settings.statusLine;
      ok('removed statusLine');
    }
  }

  for (const ev of HOOK_EVENTS) {
    const groups = (settings.hooks || {})[ev];
    if (!groups) continue;
    const kept = groups.filter(
      (g) => !(g.hooks || []).some((h) => isOurs(h.command))
    );
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  ok('removed hooks, left your other hooks alone');

  saveSettings(settings);
  fs.rmSync(ROOT, { recursive: true, force: true });
  ok('removed ~/.claude/didyouknow');

  console.log(`\nRestart Claude Code.\n`);
}

// ---------------------------------------------------------------- main

const cmd = (process.argv[2] || 'install').toLowerCase();
const actions = { install, uninstall, remove: uninstall, doctor, check: doctor };

if (!actions[cmd]) {
  console.log(`\nusage: npx claude-didyouknow [install|doctor|uninstall]\n`);
  process.exit(1);
}

try {
  actions[cmd]();
} catch (e) {
  console.error(`\n${c.r('failed:')} ${e.message}\n`);
  process.exit(1);
}
