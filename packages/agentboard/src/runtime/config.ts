import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PartialTheme } from "./themes";

export interface AgentboardConfig {
  /** Explicit mux provider name (overrides auto-detect) */
  mux?: string;
  /** Custom server port */
  port?: number;
  /** Theme: builtin name (e.g. "catppuccin-latte") or partial inline theme object */
  theme?: string | PartialTheme;
  /** Sidebar column width (default 26) */
  sidebarWidth?: number;
  /** Sidebar position relative to the terminal window (default "left") */
  sidebarPosition?: "left" | "right";
  /** Tmux prefix key for sidebar toggle (default "s") */
  keybinding?: string;
}

const DEFAULTS: AgentboardConfig = {};

const TOOL_NAME = "towles-tool-tmux";

/** Config directory shared by the towles-tool-tmux CLI and agentboard (~/.config/towles-tool-tmux) */
export function configDir(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".config", TOOL_NAME);
}

export function settingsPath(homeDir?: string): string {
  return join(configDir(homeDir), `${TOOL_NAME}.settings.json`);
}

function readSettingsFile(homeDir?: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(homeDir), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Load agentboard config from ~/.config/towles-tool-tmux/towles-tool-tmux.settings.json
 * under the "agentboard" key.
 * @param homeDir — override home directory (for testing)
 */
export function loadConfig(homeDir?: string): AgentboardConfig {
  const settings = readSettingsFile(homeDir);
  const agentboard = settings.agentboard;

  if (!agentboard || typeof agentboard !== "object") {
    return { ...DEFAULTS };
  }

  return { ...DEFAULTS, ...(agentboard as Partial<AgentboardConfig>) };
}

/**
 * Save partial agentboard config updates to the main settings file.
 * Merges with existing agentboard config to preserve fields.
 * @param updates — partial config fields to write
 * @param homeDir — override home directory (for testing)
 */
export function saveConfig(updates: Partial<AgentboardConfig>, homeDir?: string): void {
  const filePath = settingsPath(homeDir);
  const settings = readSettingsFile(homeDir);
  const existing = (settings.agentboard ?? {}) as Partial<AgentboardConfig>;
  const merged = { ...existing, ...updates };

  settings.agentboard = merged;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Load preferredEditor from the main settings file.
 * @param homeDir — override home directory (for testing)
 */
export function loadPreferredEditor(homeDir?: string): string {
  const settings = readSettingsFile(homeDir);
  const editor = settings.preferredEditor;
  return typeof editor === "string" && editor.length > 0 ? editor : "code";
}
