import { defineCommand } from "citty";
import { execSync, spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve } from "node:path";
import consola from "consola";
import { colors } from "consola/utils";
import { debugArg } from "./shared.js";

const SERVER_HOST = process.env.TT_AGENTBOARD_HOST || "127.0.0.1";
const SERVER_PORT = Number(process.env.TT_AGENTBOARD_PORT) || 4201;

// Keybinding defaults
const DEFAULT_KEY = "a";
const TMUX_BINDINGS = { toggle: "t", focus: "s" } as const;
const RUN_SHELL_LINE = "run-shell 'ttt agentboard init'";
const MARKER = "# agentboard";

function printNewAgentboardNote(): void {
  consola.info(
    colors.dim(
      "This is the legacy tmux AgentBoard, kept as a reference example. " +
        "The recommended, actively developed AgentBoard is `tt-agentboard` in " +
        "towles-tool-rs: https://github.com/ChrisTowles/towles-tool-rs",
    ),
  );
}

function findTmuxConf(): string | null {
  const candidates = [resolve(process.env.HOME ?? "~", ".config/tmux/tmux.conf")];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function ensureBun(): void {
  try {
    execSync("bun --version", { stdio: "pipe" });
  } catch {
    consola.error("bun is required but not found. Install: https://bun.sh");
    process.exit(1);
  }
}

function reloadTmux(): void {
  try {
    execSync(
      "tmux source-file ~/.config/tmux/tmux.conf 2>/dev/null || tmux source-file ~/.tmux.conf 2>/dev/null",
      {
        stdio: "pipe",
      },
    );
    consola.success("tmux config reloaded");
  } catch {
    consola.info("Reload tmux manually: tmux source-file ~/.config/tmux/tmux.conf");
  }
}

function showKeys(): void {
  let prefix = "C-a";
  let key = DEFAULT_KEY;
  try {
    prefix = execSync("tmux show-option -gv prefix", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const abKey = execSync(
      `tmux show-option -gv @agentboard-key 2>/dev/null || echo ${DEFAULT_KEY}`,
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    if (abKey) key = abKey;
  } catch {
    // use defaults
  }

  const { toggle, focus } = TMUX_BINDINGS;
  consola.box(
    [
      `${colors.bold("AgentBoard Keybindings")}\n`,
      `${colors.cyan(`tmux (prefix = ${prefix}, C = Ctrl):`)}`,
      `  ${prefix} ${key} ${toggle}     toggle sidebar`,
      `  ${prefix} ${key} ${focus}     focus sidebar`,
      `  ${prefix} ${key} 1-9   jump to session\n`,
      `${colors.cyan("In sidebar:")}`,
      `  Tab         cycle sessions`,
      `  j / ↓       move down`,
      `  k / ↑       move up`,
      `  Enter / l   switch to selected session`,
      `  1-9         jump to session`,
      `  d           hide session`,
      `  x           kill session`,
      `  r           refresh`,
      `  ?           help`,
      `  q           quit`,
    ].join("\n"),
  );
}

function setup(): void {
  const confPath = findTmuxConf();
  if (!confPath) {
    consola.warn("No tmux.conf found. Add this line manually:");
    consola.info(colors.cyan(`  ${RUN_SHELL_LINE}`));
    return;
  }

  let editPath = confPath;
  try {
    editPath = realpathSync(confPath);
  } catch {
    // keep confPath
  }

  const content = readFileSync(editPath, "utf8");
  if (content.includes(MARKER)) {
    consola.success("Already installed in tmux.conf");
    reloadTmux();
    printNewAgentboardNote();
    return;
  }

  const tpmLine = "run '~/.config/tmux/plugins/tpm/tpm'";
  const altTpmLine = "run-shell '~/.tmux/plugins/tpm/tpm'";
  const insertLines = `\n${MARKER}\n${RUN_SHELL_LINE}\n`;

  let newContent: string;
  if (content.includes(tpmLine)) {
    newContent = content.replace(tpmLine, `${insertLines}\n${tpmLine}`);
  } else if (content.includes(altTpmLine)) {
    newContent = content.replace(altTpmLine, `${insertLines}\n${altTpmLine}`);
  } else {
    newContent = content + insertLines;
  }

  writeFileSync(editPath, newContent);
  consola.success(`Added agentboard to ${editPath}`);

  reloadTmux();
  showKeys();
  printNewAgentboardNote();
}

function uninstall(): void {
  const confPath = findTmuxConf();
  if (!confPath) {
    consola.info("No tmux.conf found.");
    return;
  }

  let editPath = confPath;
  try {
    editPath = realpathSync(confPath);
  } catch {
    // keep confPath
  }

  const content = readFileSync(editPath, "utf8");
  if (!content.includes(MARKER) && !content.includes(RUN_SHELL_LINE)) {
    consola.info("agentboard not found in tmux.conf");
    return;
  }

  const newContent = content
    .split("\n")
    .filter((line) => !line.includes(MARKER) && !line.includes(RUN_SHELL_LINE))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  writeFileSync(editPath, newContent);
  consola.success("Removed agentboard from tmux.conf");
  reloadTmux();
}

function startServer(): void {
  ensureBun();
  printNewAgentboardNote();

  const agentboardDir = resolve(import.meta.dirname, "../../packages/agentboard");
  const serverEntry = resolve(agentboardDir, "src/server/main.ts");
  consola.info("Starting agentboard server (foreground, Ctrl+C to stop)...");

  execSync(`bun run ${serverEntry}`, {
    stdio: "inherit",
    cwd: agentboardDir,
  });
}

async function serverAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const PID_FILE = "/tmp/agentboard.pid";
// Matches SERVER_ERR_LOG in packages/agentboard/src/runtime/debug.ts.
const SERVER_ERR_LOG = "/tmp/agentboard-server-err.log";

async function stopServer(): Promise<boolean> {
  // Preferred path: terminate the process named in the PID file.
  if (existsSync(PID_FILE)) {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (!Number.isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process already dead
      }
      try {
        unlinkSync(PID_FILE);
      } catch {
        // intentionally ignored: PID file may already be gone
      }
      return true;
    }
  }

  // Fallback: the PID file is missing/stale but a server is still squatting
  // the port (e.g. file rotated out from under a long-lived process). Ask it
  // to shut itself down so restart actually replaces it instead of no-oping.
  if (await serverAlive()) {
    await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
    return true;
  }

  return false;
}

interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// Build a human-readable reason for why the spawned server never bound the
// port, drawing on the spawn error, the child's exit status, and the captured
// server log. Keeps the silent `exit 1` from being undiagnosable.
function describeServerStartFailure(spawnError: Error | null, exit: ServerExit | null): string {
  const parts: string[] = [];
  if (spawnError) {
    parts.push(
      (spawnError as NodeJS.ErrnoException).code === "ENOENT"
        ? "could not launch `ttt` (not found on PATH for the spawned process)"
        : `failed to spawn server: ${spawnError.message}`,
    );
  }
  if (exit && (exit.code ?? 0) !== 0) {
    parts.push(`server process exited early (code ${exit.code}, signal ${exit.signal ?? "none"})`);
  }
  const log = existsSync(SERVER_ERR_LOG) ? readFileSync(SERVER_ERR_LOG, "utf8").trim() : "";
  if (log) {
    parts.push(`server log (${SERVER_ERR_LOG}):\n${log.split("\n").slice(-12).join("\n")}`);
  } else if (parts.length === 0) {
    parts.push(`no server output captured; see ${SERVER_ERR_LOG}`);
  }
  return parts.join("\n");
}

async function ensureServerUp(): Promise<boolean> {
  if (await serverAlive()) return true;

  consola.info("Starting agentboard server...");

  // Capture the spawned server's output and exit so a crash (port already in
  // use, missing `ttt` on PATH, etc.) surfaces a reason instead of a bare exit 1.
  const errFd = openSync(SERVER_ERR_LOG, "w");
  let spawnError: Error | null = null;
  let exit: ServerExit | null = null;

  const child = spawn("ttt", ["agentboard", "server"], {
    stdio: ["ignore", errFd, errFd],
    detached: true,
  });
  child.on("error", (err) => {
    spawnError = err;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.unref();
  closeSync(errFd);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await serverAlive()) return true;
    // A healthy server runs forever; if it already errored or exited, the
    // remaining wait is wasted — fail fast with the captured reason.
    if (spawnError || exit) break;
  }

  consola.error(
    `agentboard server did not come up on ${SERVER_HOST}:${SERVER_PORT}\n${describeServerStartFailure(spawnError, exit)}`,
  );
  return false;
}

function tmuxDisplay(fmt: string): string {
  try {
    const r = spawnSync("tmux", ["display-message", "-p", fmt], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function tmuxContext(): string {
  return tmuxDisplay("#{client_tty}|#{session_name}|#{window_id}");
}

function resetTmuxKeys(): void {
  spawnSync("tmux", ["switch-client", "-T", "root"], { stdio: "pipe" });
}

function findSidebarPane(windowId: string): string | null {
  try {
    const r = spawnSync("tmux", ["list-panes", "-t", windowId, "-F", "#{pane_id} #{pane_title}"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of (r.stdout ?? "").trim().split("\n")) {
      const [paneId, title] = line.split(" ", 2);
      if (title === "agentboard-sidebar" && paneId) return paneId;
    }
  } catch (err) {
    consola.debug(`findSidebarPane failed for window ${windowId}:`, err);
  }
  return null;
}

function tmux(...args: string[]): void {
  spawnSync("tmux", args, { stdio: "pipe" });
}

function init(): void {
  const port = process.env.TT_AGENTBOARD_PORT ?? "4201";
  const host = process.env.TT_AGENTBOARD_HOST ?? "127.0.0.1";

  // Read tmux options with defaults
  const keyResult = spawnSync("tmux", ["show-option", "-gqv", "@agentboard-key"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const key = (keyResult.stdout ?? "").trim() || DEFAULT_KEY;

  // Export to tmux environment
  tmux("set-environment", "-g", "TT_AGENTBOARD_PORT", port);
  tmux("set-environment", "-g", "TT_AGENTBOARD_HOST", host);

  // Bind keybindings via command table "agentboard"
  tmux("bind-key", "-T", "prefix", key, "switch-client", "-T", "agentboard");
  tmux(
    "bind-key",
    "-T",
    "agentboard",
    TMUX_BINDINGS.toggle,
    "run-shell",
    "ttt agentboard run --toggle",
  );
  tmux(
    "bind-key",
    "-T",
    "agentboard",
    TMUX_BINDINGS.focus,
    "run-shell",
    "ttt agentboard run --focus",
  );

  // Number keys 1-9 switch to session by index
  for (let i = 1; i <= 9; i++) {
    tmux(
      "bind-key",
      "-T",
      "agentboard",
      String(i),
      "run-shell",
      `curl -s -X POST 'http://${host}:${port}/switch-index?index=${i}' -d "$(tmux display-message -p '#{q:client_tty}|#{q:session_name}|#{q:window_id}')" >/dev/null 2>&1 || true`,
    );
  }

  // Hooks — must match server's setupHooks() in provider.ts
  const hookPost = (path: string, body?: string) => {
    const bodyArg = body ? ` -d \\"${body}\\"` : "";
    return `run-shell -b "curl -s -X POST http://${host}:${port}${path}${bodyArg} >/dev/null 2>&1 || true"`;
  };
  const focusBody = "#{q:client_tty}|#{q:session_name}|#{q:window_id}";
  const resizeBody =
    "#{q:pane_id}|#{q:session_name}|#{q:window_id}|#{q:pane_width}|#{q:window_width}";

  tmux(
    "set-hook",
    "-g",
    "client-session-changed",
    `${hookPost("/focus", focusBody)} ; ${hookPost("/ensure-sidebar", focusBody)}`,
  );
  tmux("set-hook", "-g", "session-created", hookPost("/refresh"));
  tmux("set-hook", "-g", "session-closed", hookPost("/refresh"));
  tmux("set-hook", "-g", "client-resized", hookPost("/resize-sidebars"));
  tmux("set-hook", "-g", "after-select-window", hookPost("/ensure-sidebar", focusBody));
  tmux("set-hook", "-g", "after-new-window", hookPost("/ensure-sidebar", focusBody));
  tmux("set-hook", "-g", "after-resize-pane", hookPost("/resize-sidebars", resizeBody));
}

async function runToggle(): Promise<void> {
  if (!(await ensureServerUp())) process.exit(0);
  const ctx = tmuxContext();
  await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/toggle`, { method: "POST", body: ctx }).catch(
    () => {},
  );
  resetTmuxKeys();
}

async function runFocus(): Promise<void> {
  const windowId = tmuxDisplay("#{window_id}");
  if (!windowId) process.exit(0);

  // If sidebar already exists, just focus it
  const existing = findSidebarPane(windowId);
  if (existing) {
    spawnSync("tmux", ["select-pane", "-t", existing], { stdio: "pipe" });
    resetTmuxKeys();
    return;
  }

  // Otherwise, ensure server + open sidebar
  if (!(await ensureServerUp())) process.exit(0);
  const ctx = tmuxContext();
  await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/ensure-sidebar`, {
    method: "POST",
    body: ctx,
  }).catch(() => {});

  // Wait for sidebar pane to appear
  for (let i = 0; i < 20; i++) {
    const paneId = findSidebarPane(windowId);
    if (paneId) {
      spawnSync("tmux", ["select-pane", "-t", paneId], { stdio: "pipe" });
      resetTmuxKeys();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  resetTmuxKeys();
}

async function restart(): Promise<void> {
  ensureBun();
  printNewAgentboardNote();

  // 1. Kill stash sessions left over from hidden sidebars
  try {
    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const sessions = (result.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const name of sessions) {
      if (name.startsWith("_ab_stash")) {
        spawnSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" });
        consola.info(`Killed stash session: ${name}`);
      }
    }
  } catch {
    // no tmux or no sessions
  }

  // 2. Stop existing server, then start fresh
  const wasStopped = await stopServer();
  if (wasStopped) {
    // Wait for port to free up
    for (let i = 0; i < 20; i++) {
      if (!(await serverAlive())) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // ensureServerUp already logs the captured failure reason.
  if (!(await ensureServerUp())) process.exit(1);
  consola.success("Server is running");

  // 3. Bootstrap sidebars — refresh session list, then ensure-sidebar for
  //    each active client's window so sidebars appear without interaction.
  const base = `http://${SERVER_HOST}:${SERVER_PORT}`;
  await fetch(`${base}/refresh`, { method: "POST", signal: AbortSignal.timeout(2000) }).catch(
    () => {},
  );

  try {
    const clients = spawnSync(
      "tmux",
      ["list-clients", "-F", "#{client_tty}|#{session_name}|#{window_id}"],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lines = (clients.stdout ?? "").trim().split("\n").filter(Boolean);
    await Promise.allSettled(
      lines.map((ctx) =>
        fetch(`${base}/ensure-sidebar`, {
          method: "POST",
          body: ctx,
          signal: AbortSignal.timeout(2000),
        }),
      ),
    );
    consola.success(`Sidebars ensured for ${lines.length} client(s)`);
  } catch (err) {
    consola.error("Failed to bootstrap sidebars:", err);
  }
}

function startTui(): void {
  ensureBun();
  printNewAgentboardNote();

  const agentboardDir = resolve(import.meta.dirname, "../../packages/agentboard");
  const tuiEntry = resolve(agentboardDir, "src/tui/index.tsx");

  // The solid JSX transform must be preloaded explicitly: `bun pm pack`
  // silently excludes bunfig.toml, so a cwd-based config never survives
  // a published install.
  execSync(`bun run --preload @opentui/solid/preload ${tuiEntry}`, {
    stdio: "inherit",
    cwd: agentboardDir,
  });
}

export default defineCommand({
  meta: { name: "agentboard", description: "AgentBoard — tmux TUI sidebar" },
  args: {
    debug: debugArg,
    subcommand: {
      type: "positional",
      required: false,
      description: "Subcommand: setup, uninstall, server, tui, start, restart, run, keys",
    },
    toggle: { type: "boolean", description: "Toggle sidebar (used with 'run')" },
    focus: { type: "boolean", description: "Focus sidebar (used with 'run')" },
  },
  async run({ args }) {
    switch (args.subcommand) {
      case "setup":
        setup();
        break;
      case "uninstall":
        uninstall();
        break;
      case "server":
        startServer();
        break;
      case "tui":
      case "start":
        startTui();
        break;
      case "restart":
        await restart();
        break;
      case "init":
        init();
        break;
      case "run":
        if (args.toggle) await runToggle();
        else if (args.focus) await runFocus();
        else consola.error("Usage: ttt agentboard run --toggle | --focus");
        break;
      case "keys":
        showKeys();
        break;
      default:
        showKeys();
        break;
    }
  },
});
