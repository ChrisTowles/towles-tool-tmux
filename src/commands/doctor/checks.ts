import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import consola from "consola";
import { run } from "../../lib/index.js";

export interface CheckResult {
  name: string;
  version: string | null;
  ok: boolean;
  warning?: string;
}

export interface DoctorRunResult {
  timestamp: string;
  tools: CheckResult[];
  ghAuth: boolean;
  plugins: { name: string; ok: boolean }[];
  agentboard: { name: string; ok: boolean }[];
}

export async function checkCommand(
  name: string,
  args: string[],
  versionPattern: RegExp,
  optional = false,
): Promise<CheckResult> {
  try {
    const result = await run(name, args);
    const output = result.stdout + result.stderr;
    const match = output.match(versionPattern);
    return {
      name,
      version: match?.[1] ?? output.trim().slice(0, 20),
      ok: true,
    };
  } catch {
    consola.debug(`Tool check failed for "${name}"`);
    return {
      name,
      version: null,
      ok: optional,
      warning: optional ? "optional, not installed" : undefined,
    };
  }
}

export async function checkGhAuth(): Promise<{ ok: boolean }> {
  try {
    const result = await run("gh", ["auth", "status"]);
    return { ok: result.exitCode === 0 };
  } catch {
    consola.debug("GitHub CLI auth check failed");
    return { ok: false };
  }
}

export interface AgentBoardCheck {
  name: string;
  value: string;
  ok: boolean;
  warning?: string;
  hint?: string;
}

export function checkAgentBoard(): AgentBoardCheck[] {
  const results: AgentBoardCheck[] = [];

  const defaultDataDir = resolve(
    process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config"),
    "towles-tool",
    "agentboard",
  );
  const dataDir = process.env.AGENTBOARD_DATA_DIR ?? defaultDataDir;
  const dbPath = join(dataDir, "agentboard.db");
  const configPath = join(dataDir, "config.json");

  const dbExists = existsSync(dbPath);
  results.push({
    name: "database",
    value: dbExists ? dbPath : "not found",
    ok: dbExists,
    hint: dbExists ? undefined : "Run: ttt ag (starts server and creates DB automatically)",
  });

  let repoPaths: string[] = [];
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      repoPaths = config.repoPaths ?? [];
    } catch {
      // Corrupted config
    }
  }

  results.push({
    name: "scan paths",
    value: repoPaths.length > 0 ? repoPaths.join(", ") : "none configured",
    ok: repoPaths.length > 0,
    warning: repoPaths.length === 0 ? "no scan paths" : undefined,
    hint:
      repoPaths.length === 0
        ? "Run: ttt ag → open Workspaces → run the onboarding wizard"
        : undefined,
  });

  results.push({
    name: "data dir",
    value: dataDir,
    ok: true,
  });

  return results;
}

export interface PluginCheck {
  name: string;
  ok: boolean;
  installHint?: string;
}

export async function checkClaudePlugins(): Promise<PluginCheck[]> {
  const requiredPlugins = [
    {
      id: "code-simplifier@claude-plugins-official",
      name: "code-simplifier",
      installCmd: "claude plugin install code-simplifier@claude-plugins-official --scope user",
    },
  ];

  try {
    const result = await run("claude", ["plugin", "list", "--json"]);
    const plugins: { id: string }[] = JSON.parse(result.stdout);
    const installedIds = new Set(plugins.map((p) => p.id));

    return requiredPlugins.map((p) => ({
      name: p.name,
      ok: installedIds.has(p.id),
      installHint: installedIds.has(p.id) ? undefined : `Run: ${p.installCmd}`,
    }));
  } catch {
    consola.debug("Failed to list Claude plugins");
    return requiredPlugins.map((p) => ({
      name: p.name,
      ok: false,
      installHint: `Run: ${p.installCmd}`,
    }));
  }
}

export async function runAllChecks(): Promise<DoctorRunResult> {
  const tools = await Promise.all([
    checkCommand("git", ["--version"], /git version ([\d.]+)/),
    checkCommand("gh", ["--version"], /gh version ([\d.]+)/),
    checkCommand("node", ["--version"], /v?([\d.]+)/),
    checkCommand("bun", ["--version"], /([\d.]+)/),
    checkCommand("claude", ["--version"], /([\d.]+)/),
    checkCommand("tmux", ["-V"], /tmux ([\d.]+)/),
    checkCommand("ttyd", ["--version"], /ttyd version ([\d.]+)/, true),
  ]);

  const ghAuth = await checkGhAuth();
  const pluginChecks = await checkClaudePlugins();
  const agentboardChecks = checkAgentBoard();

  return {
    timestamp: new Date().toISOString(),
    tools,
    ghAuth: ghAuth.ok,
    plugins: pluginChecks.map(({ name, ok }) => ({ name, ok })),
    agentboard: agentboardChecks.map(({ name, ok }) => ({ name, ok })),
  };
}
