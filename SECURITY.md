# Security notes

## Threat model

Two untrusted inputs reach this code:

1. **Model-generated fact text.** Written to a terminal. Untrusted output.
2. **Hook/statusline JSON from Claude Code**, notably `session_id`, which is
   interpolated into filesystem paths.

Everything else (`settings.json`, `config.json`, the runtime scripts) is
owner-controlled. The relevant adversaries are a compromised or manipulated
model response, and another local user on a shared host.

## Findings from the adversarial audit, and their fixes

Ten issues were found by `audit.js` and fixed. Re-run it any time:
`HOME=/tmp/scratch node audit.js`.

| ID | Issue | Fix |
|---|---|---|
| A1 | OSC 52 in fact text wrote to the system clipboard | strip all C0/C1 controls before render |
| A2 | OSC 8 forged clickable hyperlinks | same |
| A3 | CSI cursor/erase sequences enabled UI spoofing | same |
| A4 | newlines injected extra status rows | whitespace collapsed to spaces |
| A5 | OSC 0 hijacked the window title | same |
| B1 | `session_id` traversal created files outside the data dir | `^[A-Za-z0-9_-]{1,128}$` allowlist |
| B4 | `session_id` traversal read attacker-planted fact files anywhere on disk | same |
| C1 | the user's prompt was passed in argv, readable via `ps` by any local user | passed via environment instead, capped at 8 KiB |
| C2 | data and cache dirs were created 755 under a default umask | `mkdir` 700 plus explicit `chmod` |
| — | `settings.json` was written non-atomically and would follow a symlink | temp-file + `rename`, and `lstat` refusal of non-regular files |

Sanitisation is applied twice: when facts are written to cache, and again at
render time. A cache file written by an older version cannot bypass it.

Bidi control characters (U+202A–U+202E, U+2066–U+2069) are stripped too, so
fact text cannot reorder its own rendering.

## Prompt is data, not instruction

The generator shows the user's prompt to a model in order to classify its
subject domain. An earlier version concatenated instructions then the prompt,
which made the model answer the prompt instead of classifying it -- an
unintentional instruction/data confusion with the same shape as prompt
injection. Now the instructions live in `--system-prompt`, the prompt is fenced
in `<specimen>` tags and labelled as data, and the instruction is restated after
the fence.

The generator also runs with `--tools ""` from a neutral working directory. It
previously inherited the session's cwd, so `claude -p` loaded the project's
`CLAUDE.md` and settings and reasoned about the user's repository on every
prompt. Trivia generation needs no repository access.

Escape-sequence stripping matters more here than it looks: a model can emit
valid JSON containing `\u001b`, which parses into a real ESC byte. That path is
tested in `audit.js` and neutralised at both write and render time.

## Accepted risk: `config.json` `baseCommand`

`baseCommand` runs through a shell. This is deliberate: a Claude Code
`statusLine` command is a shell command by contract, and the feature exists to
preserve a status line you already had — including inline forms like
`jq -r '...'`. Removing `shell: true` would break that.

This is not a privilege boundary. Anyone who can write `config.json` can write
`~/.claude/settings.json` and get the same execution directly from Claude Code.

Mitigations applied anyway:

- `baseCommand` is ignored unless `config.json` is a regular file (not a
  symlink), owned by the current user, and not group- or world-writable.
- The child is bounded: 1 s timeout, 256 KiB output cap.
- `doctor` reports when the config is untrusted and the command is being skipped.

If you would rather not have the behaviour at all, delete `baseCommand` from
`~/.claude/didyouknow/config.json`.

## Supply chain

Zero runtime dependencies; `npm audit` reports no vulnerabilities. No network
access, no `eval`, no dynamic `require`. The only `child_process` calls are
`claude -p` (fixed argv, no shell), the smoke tests, and `baseCommand` above.

## Resource bounds

stdin 1 MiB · prompt 8 KiB · fact array 256 entries · fact string 300 chars ·
model output 256 KiB · `generate.log` truncated at 256 KiB · model call 45 s ·
`baseCommand` 1 s.

## Reporting

Open an issue, or mail the maintainer for anything sensitive.
