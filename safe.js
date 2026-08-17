'use strict';
// Security helpers shared by the runtime. Kept dependency-free and tiny so the
// status line hot path stays fast.

const fs = require('fs');
const path = require('path');

const MAX_STDIN = 1024 * 1024; // 1 MiB
const MAX_FACTS = 256;
const MAX_FACT_LEN = 300;
const MAX_PROMPT = 8192;

/**
 * Strip anything that a terminal would interpret as a control sequence.
 *
 * Fact text originates from a language model, so it is untrusted output being
 * written to a tty. Left raw it enables OSC 52 (clipboard write), OSC 8
 * (forged hyperlinks), OSC 0 (window title), CSI cursor/erase (UI spoofing),
 * and newline injection (extra status rows).
 *
 * Allowlist approach: keep printable characters, drop every C0 control, DEL,
 * and the C1 range. ESC is in C0 so every escape sequence loses its
 * introducer, and the remaining bytes render as inert text.
 */
function sanitizeText(s, max = MAX_FACT_LEN) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const ch of s.slice(0, max * 2)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) continue; // C0 + DEL (includes ESC, LF, CR, BEL)
    if (c >= 0x80 && c <= 0x9f) continue; // C1, incl. 8-bit CSI/OSC
    if (c === 0x200b || c === 0x200e || c === 0x200f) continue; // zero-width / bidi
    if (c >= 0x202a && c <= 0x202e) continue; // bidi overrides (trojan-source style)
    if (c >= 0x2066 && c <= 0x2069) continue; // bidi isolates
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * session_id is interpolated into a filesystem path. Unconstrained it allows
 * traversal in both directions: writing marker files outside the data dir and
 * reading attacker-placed fact files from anywhere on disk.
 */
function safeSessionId(id) {
  if (typeof id !== 'string') return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** Bounded stdin read. */
function readStdin() {
  let raw;
  try {
    raw = fs.readFileSync(0);
  } catch {
    return '';
  }
  if (raw.length > MAX_STDIN) raw = raw.subarray(0, MAX_STDIN);
  return raw.toString('utf8');
}

function parseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function readJsonFile(file, fallback) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return fallback; // refuse symlinks and specials
    if (st.size > MAX_STDIN) return fallback;
    return parseJson(fs.readFileSync(file, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

/** Create a directory owner-only, defeating a permissive umask. */
function mkdirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700); // mkdir mode is masked by umask; chmod is not
  } catch {}
}

function writeFileSecure(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

/** Write via temp + rename so an interrupted write cannot truncate the target. */
function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {}
  fs.renameSync(tmp, file);
}

/**
 * `baseCommand` is executed through a shell, because that is the contract a
 * Claude Code statusLine command already has. Anyone who can write the config
 * could equally write settings.json, so this is not a privilege boundary — but
 * refusing a config that other users can modify closes the shared-machine case
 * cheaply.
 */
function configIsTrustworthy(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return false; // symlink or special
    if (st.mode & 0o022) return false; // group- or world-writable
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_FACTS,
  MAX_FACT_LEN,
  MAX_PROMPT,
  sanitizeText,
  safeSessionId,
  readStdin,
  parseJson,
  readJsonFile,
  mkdirSecure,
  writeFileSecure,
  writeFileAtomic,
  configIsTrustworthy,
};
