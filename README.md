# Towles Tool

> **Deprecated:** I've switched to [towles-tool-rs](https://github.com/ChrisTowles/towles-tool-rs) as my daily driver. This repo is no longer actively maintained.

Personal CLI toolkit with developer utilities.

## Installation

### Claude Code Plugin

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin install tt@towles-tool
claude plugin update tt@towles-tool
```

### Global Install

```bash
bun install -g towles-tool
```

### From Source

```bash
git clone https://github.com/ChrisTowles/towles-tool.git
cd towles-tool
bun install
bun link
```

## CLI Commands

### Observability

| Command                   | Description              |
| ------------------------- | ------------------------ |
| `tt graph`                | Token Usage (auto-opens) |
| `tt graph --session <id>` | Single session           |
| `tt graph --days 14`      | Filter to last N days    |

### Git

| Command              | Description                     |
| -------------------- | ------------------------------- |
| `tt gh branch`       | Create branch from GitHub issue |
| `tt gh pr`           | Create pull request             |
| `tt gh branch-clean` | Delete merged branches          |

### Journaling

| Command                  | Alias      | Description   |
| ------------------------ | ---------- | ------------- |
| `tt journal daily-notes` | `tt today` | Weekly/daily  |
| `tt journal meeting`     | `tt m`     | Meeting notes |
| `tt journal note`        | `tt n`     | General notes |

### Utilities

| Command      | Description                    |
| ------------ | ------------------------------ |
| `tt config`  | Show configuration             |
| `tt doctor`  | Check dependencies             |
| `tt install` | Configure Claude Code settings |

## Claude Code Skills

| Skill                    | Description                   |
| ------------------------ | ----------------------------- |
| `/tt:plan`               | Create implementation plan    |
| `/tt:improve`            | Suggest codebase improvements |
| `/tt:refactor-claude-md` | Fix grammar/spelling          |
| `/tt:refine`             | Fix grammar/spelling          |

## Guidelines

- [Architecture](docs/architecture.md) - CLI structure, plugin system, tech stack
- [CICD via GitHub Actions](docs/github-actions.md) - Automated release workflow
- [Testing](docs/testings.md) - Info about Tests

## License

[MIT](./LICENSE) © [Chris Towles](https://github.com/ChrisTowles)
