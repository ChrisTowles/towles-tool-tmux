import type {
  MuxProviderV1,
  MuxSessionInfo,
  ActiveWindow,
  SidebarPane,
  SidebarPosition,
  SwitchTarget,
  WindowCapable,
  SidebarCapable,
  BatchCapable,
} from "../runtime/index";
import { TmuxClient } from "./client";
import { debugLog, resolveSwitchTargets } from "../runtime/index";

/** Settings for creating a tmux provider (ai-sdk style) */
export interface TmuxProviderSettings {
  /** Override the provider name */
  name?: string;
  /** Override the TmuxClient instance (for testing) */
  client?: TmuxClient;
}

function plog(msg: string, data?: Record<string, unknown>) {
  debugLog("provider", msg, data);
}

const STASH_SESSION = "_ab_stash";
const SIDEBAR_PANE_TITLE = "agentboard-sidebar";

export class TmuxProvider implements MuxProviderV1, WindowCapable, SidebarCapable, BatchCapable {
  readonly specificationVersion = "v1" as const;
  readonly name: string;
  private readonly tmux: TmuxClient;

  constructor(settings?: TmuxProviderSettings) {
    this.name = settings?.name ?? "tmux";
    this.tmux = settings?.client ?? new TmuxClient();
  }

  listSessions(): MuxSessionInfo[] {
    const sessions = this.tmux.listSessions().filter((s) => s.name !== STASH_SESSION);
    const activeDirs = this.tmux.getActiveSessionDirs();
    return sessions.map((s) => ({
      name: s.name,
      createdAt: s.createdAt,
      dir: activeDirs.get(s.name) ?? s.dir,
      windows: s.windowCount,
    }));
  }

  switchSession(name: string, target?: SwitchTarget): void {
    if (target?.clientTty) {
      this.tmux.switchClient(name, { clientTty: target.clientTty });
      return;
    }
    const ttys = target?.fromSession
      ? resolveSwitchTargets(this.tmux.listClients(), target.fromSession)
      : [];
    if (ttys.length === 0) {
      // No known origin — let tmux pick its most-recently-active client.
      this.tmux.switchClient(name);
      return;
    }
    for (const tty of ttys) {
      this.tmux.switchClient(name, { clientTty: tty });
    }
  }

  getCurrentSession(): string | null {
    return this.tmux.getCurrentSession();
  }

  getSessionDir(name: string): string {
    return this.tmux.getSessionDir(name);
  }

  getPaneCount(name: string): number {
    return this.tmux.getPaneCount(name);
  }

  createSession(name?: string, dir?: string): void {
    this.tmux.newSession({ name, cwd: dir });
  }

  killSession(name: string): void {
    this.tmux.killSession(name);
  }

  setupHooks(serverHost: string, serverPort: number): void {
    const base = `http://${serverHost}:${serverPort}`;
    const hookPost = (path: string, data?: string) => {
      // #{q:...} escapes shell metacharacters in each tmux variable.
      // Use escaped double quotes (\") inside the outer run-shell "..." to wrap the body.
      const body = data ? ` -d \\"${data}\\"` : "";
      return `run-shell -b "curl -s -o /dev/null -X POST ${base}${path}${body} >/dev/null 2>&1 || true"`;
    };
    // tmux expands #{} formats at hook-fire time — no need for $(tmux display-message)
    // #{q:...} shell-escapes each value to prevent injection from session names etc.
    const focusCmd = hookPost("/focus", "#{q:client_tty}|#{q:session_name}|#{q:window_id}");
    const refreshCmd = hookPost("/refresh");
    const resizeCmd = hookPost("/resize-sidebars");
    const resizePaneCmd = hookPost(
      "/resize-sidebars",
      "#{q:pane_id}|#{q:session_name}|#{q:window_id}|#{q:pane_width}|#{q:window_width}",
    );
    const ensureCmd = hookPost(
      "/ensure-sidebar",
      "#{q:client_tty}|#{q:session_name}|#{q:window_id}",
    );

    // client-session-changed: update focus AND ensure sidebar in the new session's window
    this.tmux.setGlobalHook("client-session-changed", `${focusCmd} ; ${ensureCmd}`);
    this.tmux.setGlobalHook("session-created", refreshCmd);
    this.tmux.setGlobalHook("session-closed", refreshCmd);
    this.tmux.setGlobalHook("client-resized", resizeCmd);
    this.tmux.setGlobalHook("after-select-window", ensureCmd);
    this.tmux.setGlobalHook("after-new-window", ensureCmd);
    this.tmux.setGlobalHook("after-resize-pane", resizePaneCmd);
  }

  cleanupHooks(): void {
    this.tmux.unsetGlobalHook("client-session-changed");
    this.tmux.unsetGlobalHook("session-created");
    this.tmux.unsetGlobalHook("session-closed");
    this.tmux.unsetGlobalHook("client-resized");
    this.tmux.unsetGlobalHook("after-select-window");
    this.tmux.unsetGlobalHook("after-new-window");
    this.tmux.unsetGlobalHook("after-resize-pane");
  }

  getAllPaneCounts(): Map<string, number> {
    return this.tmux.getAllPaneCounts();
  }

  listActiveWindows(): ActiveWindow[] {
    return this.tmux
      .listWindows()
      .filter((w) => w.active && w.sessionName !== STASH_SESSION)
      .map((w) => ({ id: w.id, sessionName: w.sessionName, active: w.active }));
  }

  getCurrentWindowId(): string | null {
    return this.tmux.getCurrentWindowId() || null;
  }

  cleanupSidebar(): void {
    // Kill the stash session used for hiding sidebar panes
    this.tmux.killSession(STASH_SESSION);
  }

  listSidebarPanes(sessionName?: string): SidebarPane[] {
    const panes = sessionName
      ? this.tmux.listPanes({ scope: "session", target: sessionName })
      : this.tmux.listPanes();
    const windowWidths = new Map<string, number>();
    for (const pane of panes) {
      windowWidths.set(
        pane.windowId,
        Math.max(windowWidths.get(pane.windowId) ?? 0, pane.right + 1),
      );
    }

    return panes
      .filter((p) => p.title === SIDEBAR_PANE_TITLE && p.sessionName !== STASH_SESSION)
      .map((p) => ({
        paneId: p.id,
        sessionName: p.sessionName,
        windowId: p.windowId,
        width: p.width,
        windowWidth: windowWidths.get(p.windowId),
      }));
  }

  /** Ensure the invisible stash session exists for hiding sidebar panes */
  private ensureStash(): void {
    const r = this.tmux.run(["has-session", "-t", STASH_SESSION]);
    if (!r.ok) {
      this.tmux.rawRun(["new-session", "-d", "-s", STASH_SESSION, "-x", "80", "-y", "24"]);
    }
  }

  spawnSidebar(
    sessionName: string,
    windowId: string,
    width: number,
    position: SidebarPosition,
  ): string | null {
    // Find the edge pane to split against
    const panes = this.tmux.listPanes({ scope: "window", target: windowId });
    plog("spawnSidebar", { windowId, paneCount: panes.length });
    if (panes.length === 0) return null;

    const targetPane =
      position === "left"
        ? panes.reduce((a, b) => (a.left <= b.left ? a : b))
        : panes.reduce((a, b) => (a.right >= b.right ? a : b));

    // --- Try to restore a stashed sidebar pane ---
    try {
      const stashPanes = this.tmux.listPanes({ scope: "session", target: STASH_SESSION });
      const stashedPane = stashPanes.find((p) => p.title === SIDEBAR_PANE_TITLE);
      if (stashedPane) {
        plog("spawnSidebar: restoring from stash", {
          paneId: stashedPane.id,
          target: targetPane.id,
        });
        const joinFlag = position === "left" ? "-hb" : "-h";
        this.tmux.rawRun([
          "join-pane",
          joinFlag,
          "-f",
          "-l",
          String(width),
          "-s",
          stashedPane.id,
          "-t",
          targetPane.id,
        ]);
        this.tmux.setPaneTitle(stashedPane.id, SIDEBAR_PANE_TITLE);
        // Do NOT selectPane here — same as fresh spawns. The TUI's
        // restoreTerminalModes fires on focus-in after join-pane, generating
        // capability query responses. Refocusing the main pane immediately
        // causes those responses to leak as garbage escape sequences.
        return stashedPane.id;
      }
    } catch {
      /* stash session doesn't exist yet — spawn fresh */
    }

    // --- No stashed pane, spawn fresh ---
    plog("spawnSidebar: spawning new", { target: targetPane.id, width, position });
    const newPane = this.tmux.splitWindow({
      target: targetPane.id,
      direction: "horizontal",
      before: position === "left",
      fullWindow: true,
      size: width,
      command: `REFOCUS_WINDOW=${windowId} exec ttt agentboard tui`,
    });

    if (!newPane) {
      plog("spawnSidebar: splitWindow FAILED");
      return null;
    }

    this.tmux.setPaneTitle(newPane.id, SIDEBAR_PANE_TITLE);
    // Do NOT selectPane here for fresh spawns — the TUI's refocusMainPane()
    // handles it after terminal capability detection finishes. Refocusing
    // immediately causes capability query responses (DECRPM, DA1, Kitty
    // graphics) to be routed to the main pane as garbage escape sequences.
    return newPane.id;
  }

  hideSidebar(paneId: string): void {
    this.ensureStash();
    // Ensure the stash window is large enough to accept another pane.
    // join-pane fails with "pane too small" when stash panes fill up.
    this.tmux.rawRun(["resize-window", "-t", `${STASH_SESSION}:`, "-x", "200", "-y", "200"]);
    plog("hideSidebar: stashing pane", { paneId });
    this.tmux.rawRun(["join-pane", "-d", "-s", paneId, "-t", `${STASH_SESSION}:`]);
  }

  killSidebarPane(paneId: string): void {
    this.tmux.killPane(paneId);
  }

  resizeSidebarPane(paneId: string, width: number): void {
    this.tmux.resizePane(paneId, { width });
  }
}
