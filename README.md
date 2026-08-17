# claude-didyouknow — task-relevant trivia in the Claude Code status line

[![MIT license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![macOS · Linux · Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#install)
[![Claude Code](https://img.shields.io/badge/for-Claude%20Code-orange.svg)](https://docs.claude.com/en/docs/claude-code)

**A Claude Code add-on that fills dead waiting time with "did you know" facts about
whatever you just asked the agent to build — rendered in a custom `statusLine`, without
ever touching Claude's context window.**

Claude Code trivia · custom status line · hooks · zero context cost · one Haiku call per task.

```
[Opus] todoapp | 23% ctx
✦ Did you know — Kanban was designed for Toyota supply chains, not software.
```

When Claude spends ninety seconds running a test suite, the terminal is doing nothing and so
are you. `claude-didyouknow` hooks `UserPromptSubmit`, generates a batch of facts about your
actual task in a detached background process, and streams them into the Claude Code status
line one at a time until the agent stops.

## Install

```bash
npx github:gtsvaig-gambit/claude-didyouknow
```

That's it. Restart Claude Code and ask it to build something.

```bash
npx github:gtsvaig-gambit/claude-didyouknow doctor      # diagnose
npx github:gtsvaig-gambit/claude-didyouknow uninstall   # clean removal, restores your old status line
```

Pin to a tag so you get a reviewed revision rather than whatever is on the
default branch right now:

```bash
npx github:gtsvaig-gambit/claude-didyouknow#v1.3.0
```

Requires Node 18+ and `git` on PATH.

No `jq`, no `chmod`, no GNU `timeout`, no shell scripts. Node only, so it works on
macOS, Linux, and Windows.

## Why you might want it

- **Zero context cost.** Facts render straight to your terminal. Nothing is ever fed back
  into Claude's context window, so the agent's reasoning and token budget are untouched.
- **Task-relevant, not generic.** Facts are generated from the prompt you just submitted —
  ask for a Kubernetes operator and you get Kubernetes history, not fortune-cookie filler.
- **Cheap.** One Haiku call per novel task fingerprint, ~350 output tokens. Repeats are free.
- **Non-destructive install.** Backs up `~/.claude/settings.json`, appends to existing hook
  arrays instead of replacing them, and keeps your current status line as the top row.
- **Idempotent.** Run the installer twice and you get one set of hooks, not two.
- **Reversible.** `uninstall` restores what was there before.
- **Auditable.** A security harness ships in the package; run it against a throwaway `$HOME`.

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

## Why this isn't a `/plugin install` plugin

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
HOME=/tmp/dyk-audit npx github:gtsvaig-gambit/claude-didyouknow
HOME=/tmp/dyk-audit node "$(npm root -g)/claude-didyouknow/audit.js"
```

Or from a clone: `HOME=/tmp/dyk-audit node cli.js install && HOME=/tmp/dyk-audit npm run audit`.

Expect 14 blocked checks and one finding — `E1`, the documented and accepted
`baseCommand` behaviour. See [SECURITY.md](SECURITY.md).

It refuses to run against your real home directory, because it creates canary
files and deletes `$HOME/IMPORTANT.txt`.

## FAQ

**How do I customize the Claude Code status line?**
Claude Code reads a `statusLine` command from `~/.claude/settings.json` and renders its
stdout under the prompt. This project installs one for you (and preserves any command you
already had as the first row), so you don't have to write the JSON by hand.

**Does it slow Claude Code down or use up my context window?**
No. Fact generation runs in a detached process and the output goes to your terminal, never
back into the conversation. The status line process itself takes about 40ms per refresh.

**Which Claude Code hooks does it use?**
`UserPromptSubmit` to kick off generation, plus `Stop` and session cleanup hooks to make
the fact row disappear when the agent finishes. Existing hooks in your settings are kept.

**Does it work on Windows?**
Yes. Everything is Node — no shell scripts, no `jq`, no `chmod`, no GNU `timeout`.

**How much does it cost to run?**
One Claude Haiku call (~350 output tokens) the first time you ask for a given kind of task.
Identical tasks hit the cache and cost nothing.

**How do I remove it?**
`npx github:gtsvaig-gambit/claude-didyouknow uninstall` — it restores the backed-up
settings and your previous status line.

## Keywords

Claude Code, claude-code, Anthropic Claude, Claude Code status line, statusline, custom
status line, Claude Code hooks, UserPromptSubmit hook, Stop hook, Claude Code add-on,
Claude Code extension, Claude Code plugin alternative, AI coding assistant, agentic coding,
agent status line, developer productivity, terminal trivia, did you know facts, CLI tool,
npx installer, Node.js, Claude Haiku, macOS, Linux, Windows.

## License

MIT. See [LICENSE](LICENSE).
