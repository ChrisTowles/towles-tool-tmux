# Architecture

## CLI Application Structure

**Entry point**: `bin/run.ts` - oclif command router

- Loads settings from `~/.config/towles-tool-tmux/towles-tool-tmux.settings.json`
- Routes to oclif commands in `src/commands/`

**Configuration System**:

- `src/config/settings.ts` - User settings management with Zod validation
- `src/commands/base.ts` - BaseCommand class extending oclif Command with shared flags/settings

**Available CLI Commands**:

- `config` (alias: `cfg`) - Display current configuration settings
- `doctor` - Check system dependencies and environment
- `gh branch` - Create git branch from GitHub issue
- `gh pr` - Create PR from current branch
- `gh branch-clean` - Delete merged branches
- `install` - Configure Claude Code settings
- `journal daily-notes` (alias: `today`) - Weekly files with daily sections
- `journal meeting` (alias: `m`) - Structured meeting notes
- `journal note` (alias: `n`) - General-purpose notes
- `graph` - Claude Code token visualization
  **Key Utilities**:

- `src/utils/git/` - Git and GitHub CLI wrappers
- `src/utils/date-utils.ts` - Date formatting using Luxon
- `src/lib/journal/` - Journal template and file generation utilities

## Error Handling Convention

- **Internal calls**: Use `git()` / throwing `exec()` — failures are exceptional and should abort.
- **Probing / optional operations**: Use `execSafe()` — when failure is an expected branch (e.g., checking if a branch exists).
- **Never** mix: don't catch a throwing call just to convert to `{ ok }`. Pick the right function upfront.

## Technology Stack

- **Runtime**: Node.js + tsx (runs TypeScript via tsx loader)
- **CLI Framework**: oclif (commands auto-discovered in `src/commands/`)
- **Testing**: vitest with `@oclif/test` for command testing
- **Linting**: oxlint
- **Formatting**: oxfmt
- **Package Manager**: bun
- **Git Hooks**: simple-git-hooks with lint-staged (runs oxfmt + oxlint on pre-commit)
- **Terminal Graphics**: consola - use `consola.box({ title, message })` for styled boxes, `consola.info/warn/error` for styled logs
