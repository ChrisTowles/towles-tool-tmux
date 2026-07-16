---
name: towles-tool
description: Use towles-tool (`ttt`) CLI for git helpers, journaling, and developer utilities. Use when asked about "ttt commands", "create branch from issue", "daily notes", "meeting notes", or "check dependencies".
user_invocable: true
---

# towles-tool CLI

Personal CLI toolkit. Alias: `ttt`

Config: `~/.config/towles-tool/towles-tool.settings.json`

## Git

```bash
ttt gh branch        # Create branch from GitHub issue
ttt gh pr            # Create pull request
ttt gh branch-clean  # Delete merged branches
```

## Journaling

```bash
ttt journal daily-notes  # Weekly file, daily sections (alias: ttt today)
ttt journal meeting      # Meeting notes (alias: ttt m)
ttt journal note         # General notes (alias: ttt n)
```

## Utilities

```bash
ttt config   # Show config (alias: cfg)
ttt doctor   # Check dependencies
ttt graph    # Visualize dependency graph
ttt install  # Configure Claude Code settings
```
