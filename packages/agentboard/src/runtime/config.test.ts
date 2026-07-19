import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, loadPreferredEditor } from "./config";

const TEST_HOME = join(import.meta.dir, ".test-home");
const CONFIG_DIR = join(TEST_HOME, ".config", "towles-tool-tmux");
const SETTINGS_FILE = join(CONFIG_DIR, "towles-tool-tmux.settings.json");

describe("config", () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    it("returns defaults when no settings file exists", () => {
      const config = loadConfig(TEST_HOME);
      expect(config.port).toBeUndefined();
      expect(config.theme).toBeUndefined();
      expect(config.sidebarWidth).toBeUndefined();
    });

    it("reads agentboard config from settings file", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(
        SETTINGS_FILE,
        JSON.stringify({
          preferredEditor: "cursor",
          agentboard: {
            port: 4201,
            theme: "tokyo-night",
            sidebarWidth: 30,
          },
        }),
      );

      const config = loadConfig(TEST_HOME);
      expect(config.port).toBe(4201);
      expect(config.theme).toBe("tokyo-night");
      expect(config.sidebarWidth).toBe(30);
    });

    it("handles malformed JSON gracefully", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(SETTINGS_FILE, "not json {{{");

      const config = loadConfig(TEST_HOME);
      expect(config.port).toBeUndefined();
    });

    it("handles missing agentboard key", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(SETTINGS_FILE, JSON.stringify({ preferredEditor: "code" }));

      const config = loadConfig(TEST_HOME);
      expect(config.port).toBeUndefined();
    });
  });

  describe("saveConfig", () => {
    it("creates settings file with agentboard key", () => {
      saveConfig({ theme: "gruvbox-dark" }, TEST_HOME);

      expect(existsSync(SETTINGS_FILE)).toBe(true);
      const saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
      expect(saved.agentboard.theme).toBe("gruvbox-dark");
    });

    it("merges with existing agentboard config", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(
        SETTINGS_FILE,
        JSON.stringify({
          preferredEditor: "cursor",
          agentboard: {
            theme: "nord",
            sidebarWidth: 28,
          },
        }),
      );

      saveConfig({ sidebarWidth: 32 }, TEST_HOME);

      const saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
      expect(saved.agentboard.theme).toBe("nord");
      expect(saved.agentboard.sidebarWidth).toBe(32);
      expect(saved.preferredEditor).toBe("cursor");
    });
  });

  describe("loadPreferredEditor", () => {
    it("returns 'code' when no settings file exists", () => {
      expect(loadPreferredEditor(TEST_HOME)).toBe("code");
    });

    it("reads preferredEditor from settings file", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(SETTINGS_FILE, JSON.stringify({ preferredEditor: "cursor" }));

      expect(loadPreferredEditor(TEST_HOME)).toBe("cursor");
    });
  });
});
