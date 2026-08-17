# claude-didyouknow

Task-relevant trivia in the Claude Code status line while the agent works.

```
[Opus] todoapp | 23% ctx
✦ Kanban was designed for Toyota supply chains, not software.
```

## Install

```bash
npx github:you/claude-didyouknow
```

That's it. Restart Claude Code and ask it to build something.

```bash
npx github:you/claude-didyouknow doctor      # diagnose
npx github:you/claude-didyouknow uninstall   # clean removal, restores your old status line
```

Pin to a tag so you get a reviewed revision rather than whatever is on the
default branch right now:

```bash
npx github:you/claude-didyouknow#v1.2.0
```

Requires Node 18+ and `git` on PATH.

No `jq`, no `chmod`, no GNU `timeout`, no shell scripts. Node only, so it works on
macOS, Linux, and Windows.

## What it touches

| Path | What |
|---|---|
| `~/.claude/didyouknow/bin/` | three runtime scripts |
| `~/.claude/didyouknow/cache/` | generated fact sets, keyed by task |
| `~/.claude/didyouknow/config.json` | your settings |
| `~/.claude/settings.json` | adds `statusLine` + 3 hooks, **backed up first** |

The installer is idempotent — run it twice and you get one set of hooks, not two.
It appends to existing hook arrays rather than replacing them, and if you already
had a `statusLine` it keeps yours as the top row instead of clobbering it.

## How it works

```
you submit a prompt
      │
      ├─► UserPromptSubmit hook ──► touch <session>.working
      │                        └──► detached worker ──► claude -p --model haiku
      │                                                      │
      │                                cache/<fingerprint>.json ◄┘
      │
      │   (agent does the real work, its context untouched)
      │
      ├─► status line re-runs every 10s ──► reads cache, prints one fact
      │
      └─► Stop hook ──► rm <session>.working ──► fact row disappears
```

Three properties that matter:

1. **Facts never touch Claude's context.** The status line renders straight to your
   terminal. A background monitor or subagent would deliver output back to Claude,
   interrupting its reasoning and burning context budget — making the work slower to
   make the wait less boring. Net loss. This avoids that entirely.
2. **The generator is fully detached** with a 45s in-process timeout. It cannot hold
   up your turn even if the model call hangs.
3. **Facts are cached by task fingerprint.** Second time you ask for a to-do app it's
   a file copy — no model call.

`refreshInterval` is the load-bearing setting. Without it the status line only re-runs
on conversation events, which go quiet during exactly the long tool-running stretches
you're trying to fill.

## Config

`~/.claude/didyouknow/config.json`:

```json
{
  "secondsPerFact": 12,
  "model": "haiku",
  "minPromptLength": 15,
  "baseCommand": "your previous status line command, if you had one"
}
```

## Cost

One Haiku call per novel task fingerprint, ~350 output tokens. Repeats are free. The
status line itself costs nothing — it's a local process, ~40ms, well inside Claude
Code's 300ms debounce.

## Why this isn't a plugin

A Claude Code plugin can ship hooks, but a plugin's `settings.json` supports only the
`agent` and `subagentStatusLine` keys — `statusLine` can only come from user or project
settings. So `/plugin install` can never deliver the display half of this. Hence an
installer.

## Known limits

- Interactive terminal only. `claude -p` runs and CI have no status line.
- `disableAllHooks`, or an org's `allowManagedHooksOnly` in managed settings, disables
  both the hooks and the custom status line **silently**. `doctor` checks the first.
- The first fact on a novel task appears a few seconds in, once the worker finishes.
- Facts are model-generated and not fact-checked. Fine as ambient flavor; don't quote
  them. If that bothers you, replace the generator with a curated bank per domain and
  use the model only to pick the domain.

## Verifying it yourself

The security harness ships with the package. Run it against a throwaway home:

```bash
mkdir -p /tmp/dyk-audit/.claude
HOME=/tmp/dyk-audit npx github:you/claude-didyouknow
HOME=/tmp/dyk-audit node "$(npm root -g)/claude-didyouknow/audit.js"
```

Or from a clone: `HOME=/tmp/dyk-audit node cli.js install && HOME=/tmp/dyk-audit npm run audit`.

Expect 14 blocked checks and one finding — `E1`, the documented and accepted
`baseCommand` behaviour. See [SECURITY.md](SECURITY.md).

It refuses to run against your real home directory, because it creates canary
files and deletes `$HOME/IMPORTANT.txt`.

MIT.
