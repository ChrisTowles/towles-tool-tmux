# Towles Tool (tmux)

> **Deprecated:** I've switched to [towles-tool-rs](https://github.com/ChrisTowles/towles-tool-rs) as my daily driver. This repo is no longer actively maintained, and its binaries are now `towles-tool-tmux`/`ttt` so they don't collide with the Rust CLI, which owns both `towles-tool` and `tt`. AgentBoard in particular is kept here only as a tmux-based reference example — see [towles-tool-rs's `tt-agentboard`](https://github.com/ChrisTowles/towles-tool-rs/tree/main/crates/tt-agentboard) for the actively developed, recommended version.
>
> This repo was originally named `towles-tool`; it was renamed to `towles-tool-tmux` once `towles-tool-rs` took over the `towles-tool` name as the actively developed CLI.

Personal CLI toolkit with developer utilities.

## Installation

### Global Install

```bash
bun install -g @towles/tool
```

Installs as `towles-tool-tmux` (and the short `ttt`).

### From Source

```bash
git clone https://github.com/ChrisTowles/towles-tool-tmux.git
cd towles-tool-tmux
bun install
bun link
```

## CLI Commands

### Observability

| Command                    | Description              |
| -------------------------- | ------------------------ |
| `ttt graph`                | Token Usage (auto-opens) |
| `ttt graph --session <id>` | Single session           |
| `ttt graph --days 14`      | Filter to last N days    |

### Git

| Command               | Description                     |
| --------------------- | ------------------------------- |
| `ttt gh branch`       | Create branch from GitHub issue |
| `ttt gh pr`           | Create pull request             |
| `ttt gh branch-clean` | Delete merged branches          |

### Journaling

| Command                   | Alias       | Description   |
| ------------------------- | ----------- | ------------- |
| `ttt journal daily-notes` | `ttt today` | Weekly/daily  |
| `ttt journal meeting`     | `ttt m`     | Meeting notes |
| `ttt journal note`        | `ttt n`     | General notes |

### Utilities

| Command       | Description                    |
| ------------- | ------------------------------ |
| `ttt config`  | Show configuration             |
| `ttt doctor`  | Check dependencies             |
| `ttt install` | Configure Claude Code settings |

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, tech stack
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Testing](docs/testings.md) - Info about Tests

## License

[MIT](./LICENSE) © [Chris Towles](https://github.com/ChrisTowles)
