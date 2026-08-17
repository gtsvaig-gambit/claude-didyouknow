#!/usr/bin/env node
'use strict';
// Renders the status line. Runs on every assistant message and every
// refreshInterval tick, so it must be fast and must never throw -- a non-zero
// exit or empty output blanks the row.

const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('./safe');

// The consumer can close the pipe before we finish writing. Without this the
// process dies on EPIPE, blanking the row and dumping a stack trace into the
// debug log on every tick.
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
});

const ROOT = path.join(os.homedir(), '.claude', 'didyouknow');
const CONFIG = path.join(ROOT, 'config.json');
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const raw = S.readStdin();
const d = S.parseJson(raw, {});
const cfg = S.readJsonFile(CONFIG, {});

// --- top row(s): delegate to the user's own status line if they had one -----
let base = null;
if (typeof cfg.baseCommand === 'string' && cfg.baseCommand && S.configIsTrustworthy(CONFIG)) {
  // spawnSync, not execSync: if the wrapped command doesn't read stdin (plenty
  // don't), writing to it raises EPIPE. execSync turns that into a throw and we
  // lose output the child already produced. spawnSync hands it back regardless.
  const r = require('child_process').spawnSync(cfg.baseCommand, {
    shell: true,
    input: raw,
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 256 * 1024,
  });
  if (r && typeof r.stdout === 'string' && r.stdout.trim()) {
    base = r.stdout.replace(/\n+$/, '');
  }
}

if (base) {
  process.stdout.write(base + '\n');
} else {
  const model = S.sanitizeText((d.model && d.model.display_name) || 'claude', 40) || 'claude';
  const dir = S.sanitizeText(path.basename((d.workspace && d.workspace.current_dir) || d.cwd || '.'), 40);
  const rawPct = Number((d.context_window && d.context_window.used_percentage) || 0);
  const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, Math.floor(rawPct))) : 0;
  process.stdout.write(`${CYAN}[${model}]${RESET} ${dir} ${DIM}| ${pct}% ctx${RESET}\n`);
}

// --- fact row: only between UserPromptSubmit and Stop ----------------------
// session_id is interpolated into a path, so it is validated, not trusted.
const sid = S.safeSessionId(d.session_id);
if (!sid) process.exit(0);
if (!fs.existsSync(path.join(ROOT, `${sid}.working`))) process.exit(0);

const facts = S.readJsonFile(path.join(ROOT, `${sid}.facts.json`), null);
if (!Array.isArray(facts) || facts.length === 0) process.exit(0);

const per = Number.isFinite(cfg.secondsPerFact) && cfg.secondsPerFact > 0
  ? Math.min(3600, Math.floor(cfg.secondsPerFact))
  : 12;
const pool = facts.slice(0, S.MAX_FACTS);

// Advance on wall clock so rotation is smooth regardless of when we re-run.
const idx = Math.floor(Date.now() / 1000 / per) % pool.length;

// Fact text is model-generated: strip control sequences before it reaches a tty.
let fact = S.sanitizeText(pool[idx]);
if (!fact) process.exit(0);

// Claude Code sets COLUMNS; terminal-width detection can't see the tty here.
const cols = parseInt(process.env.COLUMNS, 10);
const width = (Number.isFinite(cols) && cols > 0 ? cols : 80) - 6;
if (width < 20) process.exit(0);
if (fact.length > width) fact = fact.slice(0, width - 1) + '…';

process.stdout.write(`${DIM}✦ ${fact}${RESET}\n`);
