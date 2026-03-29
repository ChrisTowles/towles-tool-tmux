import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import consola from "consola";
import pc from "picocolors";

import { getConfig } from "./config.js";
import { sleep } from "./shell.js";
import { spawnClaude as defaultSpawnClaude } from "./spawn-claude.js";
import type { SpawnClaudeFn } from "./spawn-claude.js";
import { parseStreamLine } from "./stream-parser.js";

// ── Claude CLI ──

export interface ClaudeResult {
  result: string;
  is_error: boolean;
  total_cost_usd: number;
  num_turns: number;
}

export interface ClaudeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
}

const PROCESS_RETRIES = 3;
const PROCESS_RETRY_DELAY_MS = 5_000;

function logPromptAndSystemPrompt(promptFile: string, log: ClaudeLogger): void {
  // Log the prompt being sent
  const resolvedPath = promptFile.startsWith("@") ? promptFile.slice(1) : promptFile;
  try {
    const promptContent = readFileSync(resolvedPath, "utf-8");
    log.info(`${pc.bold("Prompt file:")} ${resolvedPath}`);
    log.log(pc.dim("─".repeat(60)));
    log.log(promptContent);
    log.log(pc.dim("─".repeat(60)));
  } catch {
    log.warn(`Could not read prompt file: ${resolvedPath}`);
  }

  // Log the system prompt (CLAUDE.md) if it exists
  const claudeMdPath = join(process.cwd(), "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    log.info(`${pc.bold("System prompt (CLAUDE.md):")} ${claudeMdPath}`);
    log.log(pc.dim("─".repeat(60)));
    log.log(claudeMd);
    log.log(pc.dim("─".repeat(60)));
  }
}

export async function runClaude(opts: {
  promptFile: string;
  maxTurns?: number;
  spawnFn?: SpawnClaudeFn;
  logger?: ClaudeLogger;
}): Promise<ClaudeResult> {
  const cfg = getConfig();
  const spawnFn = opts.spawnFn ?? defaultSpawnClaude;
  const log = opts.logger ?? consola;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--model",
    cfg.model,
    ...(opts.maxTurns ? ["--max-turns", String(opts.maxTurns)] : []),
    `@${opts.promptFile}`,
  ];

  log.info(`${pc.dim("▶")} Calling Claude${opts.maxTurns ? ` (max ${opts.maxTurns} turns)` : ""}…`);

  logPromptAndSystemPrompt(opts.promptFile, log);

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PROCESS_RETRIES; attempt++) {
    try {
      const result = await runClaudeStreaming(args, spawnFn, log);
      log.success(`Done — ${result.num_turns} turns, $${result.total_cost_usd.toFixed(4)}`);
      if (result.result) {
        log.log(result.result);
      }
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < PROCESS_RETRIES) {
        log.warn(
          `Claude process failed (attempt ${attempt}/${PROCESS_RETRIES}), retrying in ${PROCESS_RETRY_DELAY_MS / 1000}s…`,
        );
        await sleep(PROCESS_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError ?? new Error("runClaude failed after all retries");
}

function logActivityEvent(event: ReturnType<typeof parseStreamLine>, log: ClaudeLogger): void {
  if (!event) return;

  switch (event.kind) {
    case "tool_use":
      log.info(
        `  ${pc.dim("\u21B3")} ${event.name}${event.detail ? pc.dim(` ${event.detail}`) : ""}`,
      );
      break;
    case "thinking":
      log.info(
        `  ${pc.dim("\u21B3")} ${pc.italic("thinking")}${event.summary ? pc.dim(` ${event.summary}`) : ""}`,
      );
      break;
    case "text":
      if (event.content.trim()) {
        log.info(`  ${pc.dim("\u21B3")} ${pc.dim(event.content.split("\n")[0].trim())}`);
      }
      break;
    case "result":
      // Handled separately via capturedResult
      break;
  }
}

function runClaudeStreaming(
  args: string[],
  spawnFn: SpawnClaudeFn,
  log: ClaudeLogger,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(args);
    let capturedResult: ClaudeResult | null = null;
    let turnCount = 0;

    if (!proc.stdout) {
      reject(new Error("Claude process has no stdout"));
      return;
    }

    const rl = createInterface({ input: proc.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;

      const activity = parseStreamLine(line);
      logActivityEvent(activity, log);

      if (activity?.kind === "result") {
        capturedResult = {
          result: "",
          is_error: activity.isError,
          total_cost_usd: activity.costUsd,
          num_turns: activity.numTurns,
        };
      }

      // Track turn count from intermediate events (parser returns null for these)
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (typeof raw.num_turns === "number" && !("result" in raw)) {
          turnCount = raw.num_turns as number;
        }
        // Capture the result text from the final event
        if ("result" in raw && capturedResult) {
          capturedResult.result = String(raw.result ?? "");
        }
      } catch {
        // Skip non-JSON lines
      }
    });

    proc.on("error", (err) => {
      rl.close();
      reject(err);
    });

    proc.on("close", (code) => {
      rl.close();
      if (capturedResult) {
        resolve(capturedResult);
      } else if (code !== 0) {
        reject(new Error(`Claude process exited with code ${code}`));
      } else {
        resolve({ result: "", is_error: false, total_cost_usd: 0, num_turns: turnCount });
      }
    });
  });
}
