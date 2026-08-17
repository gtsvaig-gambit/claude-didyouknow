#!/usr/bin/env node
'use strict';
// Hook dispatcher for UserPromptSubmit / Stop / SessionEnd.
//
// CONTRACT: never write to stdout. On UserPromptSubmit, stdout is injected
// into Claude's context as additionalContext -- the exact thing this design
// exists to prevent. All diagnostics go to generate.log.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const S = require('./safe');

process.stdout.on('error', () => process.exit(0));

const ROOT = path.join(os.homedir(), '.claude', 'didyouknow');
const LOG = path.join(ROOT, 'generate.log');

const quit = () => process.exit(0);

const d = S.parseJson(S.readStdin(), null);
if (!d) quit();

// Validated, not trusted: unconstrained this is a path traversal primitive
// giving arbitrary file creation and deletion.
const sid = S.safeSessionId(d.session_id);
if (!sid) quit();

const marker = path.join(ROOT, `${sid}.working`);

try {
  S.mkdirSecure(path.join(ROOT, 'cache'));
} catch {
  quit();
}

const cfg = S.readJsonFile(path.join(ROOT, 'config.json'), {});

switch (d.hook_event_name) {
  case 'UserPromptSubmit': {
    const prompt = typeof d.prompt === 'string' ? d.prompt.trim() : '';
    if (prompt.startsWith('/')) quit();
    const min = Number.isFinite(cfg.minPromptLength) ? cfg.minPromptLength : 15;
    if (prompt.length < min) quit();

    try {
      S.writeFileSecure(marker, '');
    } catch {
      quit();
    }

    // Rotate the log rather than letting it grow without bound.
    try {
      if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.truncateSync(LOG, 0);
    } catch {}

    // Detached so it cannot hold up the turn even if the model call hangs.
    //
    // The prompt goes via the environment, NOT argv: argv is world-readable
    // through `ps` on a multi-user host, and prompts routinely contain
    // sensitive material. /proc/<pid>/environ is owner-only.
    // Log may contain fragments of model output; keep it owner-only.
    try {
      const log = fs.openSync(LOG, 'a', 0o600);
      try {
        fs.chmodSync(LOG, 0o600);
      } catch {}
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'generate.js')], {
        detached: true,
        stdio: ['ignore', 'ignore', log],
        env: {
          ...process.env,
          DYK_PROMPT: prompt.slice(0, S.MAX_PROMPT),
          DYK_SID: sid,
        },
      });
      child.unref();
    } catch {}
    break;
  }
  case 'Stop':
  case 'SessionEnd':
    try {
      fs.unlinkSync(marker);
    } catch {}
    break;
}

quit();
