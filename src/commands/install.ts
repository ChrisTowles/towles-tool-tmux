import { defineCommand } from "citty";
import { colors } from "consola/utils";
import consola from "consola";
import { debugArg } from "./shared.js";
import {
  CLAUDE_SETTINGS_PATH,
  loadClaudeSettings,
  applyRecommendedSettings,
  saveClaudeSettings,
} from "./claude-settings.js";

export default defineCommand({
  meta: {
    name: "install",
    description: "Configure Claude Code settings and optionally enable observability",
  },
  args: {
    debug: debugArg,
    observability: {
      type: "boolean",
      alias: "o",
      description: "Show OTEL setup instructions and configure SubagentStop hook",
      default: false,
    },
  },
  async run({ args }) {
    consola.log(colors.bold("\n🔧 towles-tool install\n"));

    const existing = loadClaudeSettings(CLAUDE_SETTINGS_PATH);
    if (Object.keys(existing).length > 0) {
      consola.log(colors.dim(`Found existing Claude settings at ${CLAUDE_SETTINGS_PATH}`));
    } else {
      consola.log(colors.dim(`No Claude settings file found, will create one`));
    }

    const { settings, changes } = applyRecommendedSettings(existing);

    for (const change of changes) {
      consola.log(colors.green(`✓ ${change}`));
    }

    if (!changes.some((c) => c.includes("cleanupPeriodDays"))) {
      consola.log(colors.dim("✓ cleanupPeriodDays already set to 99999"));
    }
    if (!changes.some((c) => c.includes("alwaysThinkingEnabled"))) {
      consola.log(colors.dim("✓ alwaysThinkingEnabled already set to true"));
    }

    if (changes.length > 0) {
      saveClaudeSettings(CLAUDE_SETTINGS_PATH, settings);
      consola.log(colors.green(`\n✓ Saved Claude settings to ${CLAUDE_SETTINGS_PATH}`));
    }

    if (args.observability) {
      consola.log(colors.bold("\n📊 Observability Setup\n"));
      showOtelInstructions();
    }

    consola.log(colors.bold("\n📦 Claude Plugins\n"));
    await ensureClaudePlugins();

    consola.log(colors.bold(colors.green("\n✅ Installation complete!\n")));
  },
});

async function ensureClaudePlugins(): Promise<void> {
  const { run } = await import("../lib/index.js");

  const requiredPlugins = [
    {
      id: "code-simplifier@claude-plugins-official",
      name: "code-simplifier",
    },
  ];

  let installedIds = new Set<string>();
  try {
    const result = await run("claude", ["plugin", "list", "--json"]);
    const plugins: { id: string }[] = JSON.parse(result.stdout);
    installedIds = new Set(plugins.map((p) => p.id));
  } catch {
    consola.log(colors.yellow("⚠ Could not list Claude plugins"));
  }

  for (const plugin of requiredPlugins) {
    if (installedIds.has(plugin.id)) {
      consola.log(colors.dim(`✓ ${plugin.name} already installed`));
      continue;
    }

    const answer = await consola.prompt(`Install ${plugin.name} plugin?`, {
      type: "confirm",
      initial: true,
    });

    if (answer) {
      const result = await run("claude", ["plugin", "install", plugin.id, "--scope", "user"]);
      if (result.exitCode === 0) {
        consola.log(colors.green(`✓ ${plugin.name} installed`));
      } else {
        if (result.stdout) consola.log(result.stdout);
        if (result.stderr) consola.log(colors.dim(result.stderr));
        consola.log(colors.yellow(`⚠ ${plugin.name} install exited with code ${result.exitCode}`));
      }
    } else {
      consola.log(colors.dim(`  Skipped ${plugin.name}`));
    }
  }
}

function showOtelInstructions(): void {
  consola.log(colors.cyan("Add these environment variables to your shell profile:\n"));

  consola.box(`export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`);

  consola.log("");
  consola.log(
    colors.dim("For more info, see: https://github.com/anthropics/claude-code-monitoring-guide"),
  );
  consola.log("");
  consola.log(colors.cyan("Quick cost analysis (no setup required):"));
  consola.log(colors.dim("  npx ccusage@latest --breakdown"));
}
