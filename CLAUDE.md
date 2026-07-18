# towles-tool-tmux

> Archived — superseded by [towles-tool-rs](https://github.com/ChrisTowles/towles-tool-rs). Binary here is `ttt` (not `tt`) to avoid colliding with the Rust CLI. AgentBoard in this repo is kept as a tmux-based reference example; the recommended, actively developed AgentBoard is `crates/tt-agentboard` in towles-tool-rs.
>
> This repo was originally named `towles-tool`. It was renamed to `towles-tool-tmux` after `towles-tool-rs` took over the `towles-tool` name/purpose as the actively developed CLI — this repo remains as a tmux-based reference (AgentBoard) and is no longer actively maintained.

## Worktree slots — you are probably working in one

This repo is checked out as **primary + slots**: `~/code/p/towles-tool-cli-repos/`
holds `towles-tool-primary/` (a normal clone that always has `main` checked
out) plus branch-named worktrees under `slots/`, one per parallel line of work
(a `.tt-slot` marker file sits at each slot's root). Slots are ephemeral:
created from the primary for a branch, removed when the branch merges. Manage
them with `ttr slot` (from the Rust rewrite at `~/code/p/towles-tool-repos/`)
— never raw `git worktree` or new clones:

```sh
ttr slot new -b feat/thing [--base <ref>]  # creates slots/thing on that branch
ttr slot ls [--json]                       # fleet: primary + slots, branch, dirty, ports
ttr slot env <name>                        # (re)render .env — idempotent, keeps claims
ttr slot rm <name> [--force]               # guarded removal
```

Rules when working in a slot:

- **The primary is load-bearing.** Every slot's git state lives in
  `towles-tool-primary/.git` — never delete, move, or re-clone the primary.
  `main` stays checked out there; slots never work on `main` directly.
- **One branch per slot, named after it.** `ttr slot new -b feat/thing`
  creates `slots/thing`. A merged slot is done — `ttr slot rm` it.
- **Ports come from the rendered `.env`** — `.env.example` is the template
  (`${tt:port A-B}` pool claims). Never hardcode a port; AgentBoard reads
  `TT_AGENTBOARD_PORT`.
- **No setup scripts.** `ttr slot new` runs the `TT_SLOT_SETUP` command
  declared in `.env.example` (`bun install` here), spawned directly with no
  shell.
- **Never touch sibling slot directories** — other agents work there
  concurrently.

## Commands

- `bun test` — run all tests (bun's native runner)
- `bun run test` — run all tests via vitest (node workers — no `Bun` global; keep src runtime-portable)
- `bun test -- journal` — filter tests by path
- `bun run dev` — run CLI locally (`bin/run.ts`)
- `bun run lint` — oxlint
- `bun run format` — oxfmt
- `bun typecheck` — tsgo
- `bun run link` — register global `ttt` symlink via `bun link`
- `bun run link:show` — show which slot the global `ttt` points to
- Pre-commit hook runs: format + lint:fix + typecheck

## Claude workflow

- `/verify` — run format-check + lint + typecheck + test in one shot. Use before commits and PRs.
- `verify-app` subagent — same plus CLI entrypoint and AgentBoard workspace resolution. Dispatch when verifying after risky changes.

## Architecture

- CLI framework: oclif (`src/commands/`), citty for agentboard command
- Runtime: bun
- Formatter: oxfmt, Linter: oxlint, Type checker: tsgo

## AgentBoard

- Tmux sidebar TUI plugin: `packages/agentboard/`
- Single package, source split by domain under `src/`: `src/server`, `src/tui`, `src/runtime`, `src/mux-tmux`. Cross-domain imports are relative (e.g. `../runtime/index`) — no `@tt-agentboard/*` workspace packages. Runs as source under bun from a global install.
- Agent slots: worktree slots in `~/code/p/towles-tool-cli-repos/slots/<name>` (see "Worktree slots" above)
- Multi-client invariant: "current"/"focused" session is per-client or per-TUI, never a server global. Resolve attached clients at action time (`fromSession` → `tmux list-clients`); stored ttys go stale.
- Sidebar handoff: each session has its own sidebar TUI process. A session switch moves the viewer to a _different_ TUI — click feedback must relay via the `session-viewed` event's `select` payload, not local state in the originating TUI.
- Live debugging: server WS on `127.0.0.1:4201`; `TT_AGENTBOARD_DEBUG=1` logs to `/tmp/agentboard-debug.log`; `ttt agentboard restart` picks up source changes (runs from source via bun link).
- tmux format gotcha: in scripts, `display-message -p "#{session_name}"` is pane-context (where the script runs); use `list-clients -F "#{client_session}"` to verify what a client is actually viewing.

## Testing Conventions

- vi.mock is BANNED (oxlint rule: error). Use constructor dependency injection instead.

## Claude Code Hooks

- Stop hooks fire reliably in `-p` (print) mode
- HTTP hooks silently fail if server is down (no retry) — use command hooks with retry script
- Hook config: `.claude/settings.local.json` in each slot directory
- Completion sweep plugin detects missed hooks via tmux `pane_current_command`

## Bug Fixing

- If you find a pre-existing bug or test failure (not introduced by your changes), fix it anyway — don't skip it.

## Working Style

- Plan mode (`Shift+Tab` ×2) for any non-trivial change. Align on a plan first; one-shot the implementation after.
- Verification is the #1 quality multiplier. After edits: typecheck, lint, run the touched tests. Don't claim done without proof.
- Always finish migrations. Partial migrations confuse models the same way they confuse humans — leave the codebase in one shape, not half a shape.
- Hard cutover, no backwards-compat shims. Match the user's global rule.

## Git & PRs

- Always rebase merge: `gh pr merge --rebase --admin`
- Branch protection enabled with admin bypass
