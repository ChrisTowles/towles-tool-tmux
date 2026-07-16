---
name: screenshot
description: Take a desktop screenshot for visual validation. Use this skill when you need to verify UI changes, check the agentboard sidebar, validate TUI rendering, or confirm any visual state on screen. Trigger when the user says "take a screenshot", "show me the screen", "check the UI", "validate visually", or when you need to self-validate a visual change.
user_invocable: true
---

# Desktop Screenshot

Take a screenshot of the full desktop using `cosmic-screenshot` (Cosmic DE on Wayland).

## How to take a screenshot

```bash
cosmic-screenshot --interactive=false --notify=false --save-dir /tmp 2>/dev/null
ls -t /tmp/Screenshot_*.png | head -1
```

Then read the resulting file with the `Read` tool to view it visually.

## Full workflow

1. Run the bash command above to capture the screen
2. Get the filename from the output (latest Screenshot\_\*.png in /tmp)
3. Use `Read` tool on the PNG path — Claude Code will render it as an image
4. Analyze the screenshot and report findings

## When to use

- After modifying TUI components (agentboard sidebar, StatusBar, DetailPanel)
- After restarting the agentboard (`ttt agentboard restart`)
- When debugging visual rendering issues
- When the user asks you to verify something on screen
- For self-validation after UI changes before committing

## Notes

- This only works on this machine (System76 with Cosmic DE on Wayland)
- Screenshots go to `/tmp/` and are not committed to git
- The `grim` tool is also installed but doesn't work (compositor lacks wlr-screencopy)
- X11 tools (`import`, `scrot`) don't work since this is a Wayland session (DISPLAY=:1 is XWayland)
