import { z } from "zod/v4";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import consola from "consola";
import { colors } from "consola/utils";

const TOOL_NAME = "towles-tool";

/** Default config directory */
export const DEFAULT_CONFIG_DIR = path.join(homedir(), ".config", TOOL_NAME);

/** User settings file path */
export const USER_SETTINGS_PATH = path.join(DEFAULT_CONFIG_DIR, `${TOOL_NAME}.settings.json`);

export const JournalSettingsSchema = z.object({
  // Base folder where all journal files are stored
  baseFolder: z.string().default(path.join(homedir())),
  // https://moment.github.io/luxon/#/formatting?id=table-of-tokens
  dailyPathTemplate: z
    .string()
    .default(
      path.join(
        "journal/{monday:yyyy}/{monday:MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md",
      ),
    ),
  meetingPathTemplate: z
    .string()
    .default(path.join("journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md")),
  notePathTemplate: z
    .string()
    .default(path.join("journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md")),
  // Directory for external templates (fallback to hardcoded if not found)
  templateDir: z.string().default(path.join(homedir(), ".config", TOOL_NAME, "templates")),
});

export type JournalSettings = z.infer<typeof JournalSettingsSchema>;

export const AgentboardSettingsSchema = z.object({
  mux: z.string().optional(),
  port: z.number().optional(),
  theme: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  sidebarWidth: z.number().optional(),
  sidebarPosition: z.enum(["left", "right"]).optional(),
  keybinding: z.string().optional(),
  detailPanelHeights: z.record(z.string(), z.number()).optional(),
  /** Absolute paths to repos the sidebar should always show, even with no active session */
  repoSlots: z.array(z.string()).optional(),
});

export type AgentboardSettings = z.infer<typeof AgentboardSettingsSchema>;

export const UserSettingsSchema = z.object({
  preferredEditor: z.string().default("code"),
  journalSettings: JournalSettingsSchema.optional().transform(
    (v) => v ?? JournalSettingsSchema.parse({}),
  ),
  agentboard: AgentboardSettingsSchema.optional().transform(
    (v) => v ?? AgentboardSettingsSchema.parse({}),
  ),
});

/** Schema without transforms — safe for JSON Schema export */
export const UserSettingsRawSchema = z.object({
  preferredEditor: z.string().default("code"),
  journalSettings: JournalSettingsSchema.optional(),
  agentboard: AgentboardSettingsSchema.optional(),
});

type UserSettings = z.infer<typeof UserSettingsSchema>;

export interface SettingsFile {
  settings: UserSettings;
  path: string;
}

async function createAndSaveDefaultSettings(): Promise<UserSettings> {
  const userSettings = UserSettingsSchema.parse({});
  await saveSettings({ path: USER_SETTINGS_PATH, settings: userSettings });
  return userSettings;
}

export async function saveSettings(settingsFile: SettingsFile): Promise<void> {
  try {
    const dirPath = path.dirname(settingsFile.path);
    await mkdir(dirPath, { recursive: true });
    await writeFile(settingsFile.path, JSON.stringify(settingsFile.settings, null, 2), "utf-8");
  } catch (error) {
    consola.error("Error saving user settings file:", error);
  }
}

export async function loadSettings(): Promise<SettingsFile> {
  try {
    const userContent = await readFile(USER_SETTINGS_PATH, "utf-8");
    const parsedUserSettings: unknown = JSON.parse(userContent);
    const settings = UserSettingsSchema.parse(parsedUserSettings);

    if (JSON.stringify(parsedUserSettings) !== JSON.stringify(settings)) {
      consola.warn(`Settings file ${USER_SETTINGS_PATH} has been updated with default values.`);
      await saveSettings({ path: USER_SETTINGS_PATH, settings });
    }
    return { path: USER_SETTINGS_PATH, settings };
  } catch {
    // Settings file is missing or unparseable — (re)create it from defaults
    const isNonInteractive = process.env.CI || !process.stdout.isTTY;
    if (!isNonInteractive) {
      const confirmed = await consola.prompt(
        `Settings file not found. Create ${colors.cyan(USER_SETTINGS_PATH)}?`,
        { type: "confirm" },
      );
      if (!confirmed) {
        throw new Error(`Settings file not found and user chose not to create it.`);
      }
    } else {
      consola.info(`Creating settings file: ${USER_SETTINGS_PATH}`);
    }
    const settings = await createAndSaveDefaultSettings();
    return { path: USER_SETTINGS_PATH, settings };
  }
}
