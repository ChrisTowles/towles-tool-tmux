# tt-core

Core workflow automation commands for Claude Code.

## Commands

| Command       | Description                                   |
| ------------- | --------------------------------------------- |
| `/tt:plan`    | Interview user and create implementation plan |
| `/tt:improve` | Explore codebase and suggest improvements     |
| `/tt:refine`  | Fix grammar/spelling in files                 |

## Skills

| Skill               | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `tt:towles-tool`    | `ttt` CLI reference: git/gh helpers, journaling, dependency checks.               |
| `tt:parallel-slots` | Fan out parallel Claude Code agents across slot clones of any repo, via `gh` CLI. |

## Installation

```bash
claude plugin marketplace add ChrisTowles/towles-tool
claude plugin enable tt@towles-tool
```
