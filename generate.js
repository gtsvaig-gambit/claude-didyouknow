#!/usr/bin/env node
'use strict';
// Detached worker. Generates a small bank of facts and caches it by task
// fingerprint, so repeated work costs nothing. Runs fully outside the agent
// loop -- output goes to a file, never to Claude and never to the terminal.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const S = require('./safe');

const ROOT = path.join(os.homedir(), '.claude', 'didyouknow');
const CACHE = path.join(ROOT, 'cache');

// Read from the environment, not argv, so the prompt is not exposed via `ps`.
const prompt = (process.env.DYK_PROMPT || '').slice(0, S.MAX_PROMPT);
const sid = S.safeSessionId(process.env.DYK_SID);
if (!prompt || !sid) process.exit(0);

const cfg = S.readJsonFile(path.join(ROOT, 'config.json'), {});

// Fingerprint the task so "build a to-do app" reuses facts across sessions.
const fingerprint = crypto
  .createHash('sha256')
  .update(prompt.slice(0, 200).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
  .digest('hex')
  .slice(0, 32);

const target = path.join(CACHE, `${fingerprint}.json`);
const live = path.join(ROOT, `${sid}.facts.json`);

// Cache hit: instant, zero cost.
if (fs.existsSync(target)) {
  try {
    S.writeFileSecure(live, fs.readFileSync(target));
  } catch {}
  process.exit(0);
}

// Model is config-driven, so constrain it to a plausible identifier rather than
// letting arbitrary strings become argv for the CLI.
const model = /^[A-Za-z0-9._-]{1,64}$/.test(String(cfg.model || '')) ? String(cfg.model) : 'haiku';

const INSTRUCTIONS = `You will be given a software development task. Identify its subject
domain and write 8 genuinely surprising facts about that domain -- its history, the people
behind it, odd design decisions, notable failures, etymology.

Rules:
- About the DOMAIN, not about how to do the task. No tips, no advice.
- Each fact under 85 characters, self-contained, no leading "Did you know".
- Verifiable. If you are unsure a fact is true, leave it out.
- Output ONLY a JSON array of 8 strings. No prose, no markdown fences.

Task:
`;

// Timeout handled in-process -- no dependency on GNU `timeout`, which does not
// exist on macOS.
const child = spawn('claude', ['-p', '--model', model], {
  stdio: ['pipe', 'pipe', 'ignore'],
});

const killer = setTimeout(() => {
  try {
    child.kill('SIGKILL');
  } catch {}
}, 45000);

const MAX_OUT = 256 * 1024;
let out = '';
let over = false;

child.stdout.on('data', (b) => {
  if (over) return;
  out += b;
  if (out.length > MAX_OUT) {
    over = true;
    try {
      child.kill('SIGKILL');
    } catch {}
  }
});

child.on('error', (e) => {
  clearTimeout(killer);
  console.error(`spawn claude failed: ${e.message}`);
  process.exit(0);
});

child.on('close', () => {
  clearTimeout(killer);
  if (over) {
    console.error('model output exceeded cap, discarded');
    process.exit(0);
  }

  const cleaned = out.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim();
  const parsed = S.parseJson(cleaned, null);
  if (!Array.isArray(parsed)) {
    console.error(`model did not return a JSON array: ${cleaned.slice(0, 200)}`);
    process.exit(0);
  }

  // Sanitize at write time as well as at render time. Defence in depth: the
  // cache file is what a later session reads, and it should never hold a
  // terminal control sequence in the first place.
  const facts = parsed
    .slice(0, S.MAX_FACTS)
    .map((f) => S.sanitizeText(f))
    .filter((f) => f.length > 0);

  if (facts.length === 0) process.exit(0);

  try {
    S.mkdirSecure(CACHE);
    S.writeFileAtomic(target, JSON.stringify(facts));
    S.writeFileSecure(live, JSON.stringify(facts));
  } catch (e) {
    console.error(`write failed: ${e.message}`);
  }
  process.exit(0);
});

child.stdin.on('error', () => {});
child.stdin.end(INSTRUCTIONS + prompt + '\n');
