import { readFileSync, unlinkSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import consola from "consola";

import type { MuxProvider, SwitchTarget } from "../contracts/mux";
import { isFullSidebarCapable, isBatchCapable } from "../contracts/mux";
import { resolveSwitchTargets } from "../client-routing";
import type { AgentEvent } from "../contracts/agent";
import { TERMINAL_STATUSES } from "../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../contracts/agent-watcher";
import { AgentTracker, instanceKey } from "../agents/tracker";
import { SessionOrder } from "./session-order";
import { SessionMetadataStore } from "./metadata-store";
import { loadConfig, saveConfig, loadPreferredEditor } from "../config";
import { resolveSidebarWidthFromResizeContext, snapshotSidebarWindows } from "./sidebar-width-sync";
import type { SidebarResizeContext, SidebarResizeSuppression } from "./sidebar-width-sync";
import { shell, getGitInfo, syncGitWatchers, teardownGitWatchers, startGitPoll } from "./git-info";
import { refreshPortSnapshot, getSessionPorts, startPortPoll } from "./port-scanner";
import {
  SERVER_PORT,
  SERVER_HOST,
  PID_FILE,
  SERVER_IDLE_TIMEOUT_MS,
  STUCK_RUNNING_TIMEOUT_MS,
  STALE_AGENT_TIMEOUT_MS,
  IDLE_PRUNE_MS,
} from "../shared";
import type {
  ServerState,
  SessionData,
  SlotInfo,
  ClientCommand,
  SessionViewed,
  MetadataTone,
} from "../shared";

const VALID_TONES = new Set<string>(["neutral", "info", "success", "warn", "error"]);
function parseTone(v: unknown): MetadataTone | undefined {
  return typeof v === "string" && VALID_TONES.has(v) ? (v as MetadataTone) : undefined;
}

/** True when two pane-agent snapshots differ in their sessions or per-session instance keys. */
function paneAgentSetsDiffer(
  prev: Map<string, Map<string, unknown>>,
  next: Map<string, Map<string, unknown>>,
): boolean {
  if (prev.size !== next.size) return true;
  for (const [session, agents] of next) {
    const prevAgents = prev.get(session);
    if (!prevAgents || prevAgents.size !== agents.size) return true;
    for (const key of agents.keys()) {
      if (!prevAgents.has(key)) return true;
    }
  }
  return false;
}

/** Format seconds-since-epoch creation time as a short uptime string (e.g. "2d3h", "5m"). */
function formatUptime(createdAt: number): string {
  const diff = Math.floor(Date.now() / 1000) - createdAt;
  if (Number.isNaN(diff) || diff < 0) return "";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

// --- Debug logger ---

const DEBUG_LOG = "/tmp/agentboard-debug.log";
const DEBUG_ENABLED = !!process.env.TT_AGENTBOARD_DEBUG;

function log(category: string, msg: string, data?: Record<string, unknown>) {
  if (!DEBUG_ENABLED) return;
  const ts = new Date().toISOString().slice(11, 23);
  const extra = data ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${category}] ${msg}${extra}\n`;
  try {
    appendFileSync(DEBUG_LOG, line);
  } catch {
    // intentionally ignored: debug log file write is best-effort
  }
}

// --- Server startup ---

export function startServer(
  mux: MuxProvider,
  extraProviders?: MuxProvider[],
  watchers?: AgentWatcher[],
): void {
  const allProviders = [mux, ...(extraProviders ?? [])];
  const allWatchers = watchers ?? [];
  const tracker = new AgentTracker();
  const metadataStore = new SessionMetadataStore();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const sessionOrderPath = join(home, ".config", "towles-tool", "agentboard", "session-order.json");
  const sessionOrder = new SessionOrder(sessionOrderPath);

  // Clear previous log on server start
  try {
    writeFileSync(DEBUG_LOG, "");
  } catch {
    // intentionally ignored: clearing debug log is best-effort
  }
  log("server", "starting", { providers: allProviders.map((p) => p.name) });

  // Load initial theme from config
  const config = loadConfig();
  let currentTheme: string | undefined =
    typeof config.theme === "string" ? config.theme : undefined;
  let sidebarWidth = config.sidebarWidth ?? 35;
  let sidebarPosition: "left" | "right" = config.sidebarPosition ?? "left";
  let preferredEditor = loadPreferredEditor();
  // Visible by default so a fresh server (including `tt agentboard restart`)
  // spawns sidebars on the first ensure-sidebar without needing a toggle.
  let sidebarVisible = true;

  log("server", "config loaded", {
    sidebarWidth,
    sidebarPosition,
    theme: currentTheme,
    configKeys: Object.keys(config),
  });

  // Bootstrap active sessions — every session a client is attached to counts
  // as "being viewed" (a single getCurrentSession() is first-client-wins when
  // multiple terminals are attached). Falls back to the provider's notion of
  // current session when no clients are attached yet.
  const bootSessions = listAttachedClientSessions();
  const bootFallback = mux.getCurrentSession();
  if (bootSessions.length === 0 && bootFallback) bootSessions.push(bootFallback);
  if (bootSessions.length > 0) {
    tracker.setActiveSessions(bootSessions);
  }

  // --- Agent watcher context ---

  let watcherBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  function debouncedBroadcast() {
    if (watcherBroadcastTimer) return;
    watcherBroadcastTimer = setTimeout(() => {
      watcherBroadcastTimer = null;
      broadcastState();
    }, 200);
  }

  // Cache for dir→session resolution (rebuilt per scan cycle)
  let dirSessionCache: Map<string, string> | null = null;
  let dirSessionCacheTs = 0;
  const DIR_CACHE_TTL = 5000;

  function getDirSessionMap(): Map<string, string> {
    const now = Date.now();
    if (dirSessionCache && now - dirSessionCacheTs < DIR_CACHE_TTL) return dirSessionCache;
    const map = new Map<string, string>();
    for (const p of allProviders) {
      for (const s of p.listSessions()) {
        if (s.dir) map.set(s.dir, s.name);
      }
    }
    dirSessionCache = map;
    dirSessionCacheTs = now;
    return map;
  }

  /** Encode a path the same way Claude Code does: replace `/` with `-`. */
  function encodeProjectDir(dir: string): string {
    return dir.replace(/\//g, "-");
  }

  const watcherCtx: AgentWatcherContext = {
    resolveSession(projectDir: string): string | null {
      const map = getDirSessionMap();
      const direct = map.get(projectDir);
      if (direct) return direct;
      // Find the most specific (longest) matching session dir.
      // Without this, a project dir like /a/b could match /a/b/c (session1)
      // before /a/b/c/d (session2), assigning it to the wrong session.
      let bestMatch: string | null = null;
      let bestLen = 0;
      for (const [dir, name] of map) {
        if (projectDir.startsWith(dir + "/") || dir.startsWith(projectDir + "/")) {
          if (dir.length > bestLen) {
            bestLen = dir.length;
            bestMatch = name;
          }
        }
      }
      if (bestMatch) return bestMatch;
      // Fallback: the decoded projectDir may be wrong due to dash ambiguity.
      // Re-encode each known session dir and check if the encoded form matches
      // as a prefix of the (still-encoded) input.
      const encoded = encodeProjectDir(projectDir);
      bestMatch = null;
      bestLen = 0;
      for (const [dir, name] of map) {
        const encodedDir = encodeProjectDir(dir);
        if (encoded.startsWith(encodedDir) || encodedDir.startsWith(encoded)) {
          if (encodedDir.length > bestLen) {
            bestLen = encodedDir.length;
            bestMatch = name;
          }
        }
      }
      return bestMatch;
    },
    emit(event: AgentEvent) {
      tracker.applyEvent(event, { seed: !watchersSeeded });
      debouncedBroadcast();
    },
  };

  // Flag to track when initial watcher seeding is complete
  let watchersSeeded = false;
  setTimeout(() => {
    watchersSeeded = true;
    // Clear seed-unseen flags for every session a client is viewing
    // (handleFocus already ran before seed events arrived)
    let cleared = false;
    for (const name of listAttachedClientSessions()) {
      cleared = tracker.handleFocus(name) || cleared;
    }
    if (cleared) broadcastState();
  }, 3000);

  let lastState: ServerState | null = null;
  let clientCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clientSessionNames = new WeakMap<object, string>();
  const sessionProviders = new Map<string, MuxProvider>();

  function getCurrentSession(): string | null {
    // Try all providers until one returns a session
    for (const p of allProviders) {
      const result = p.getCurrentSession();
      if (result) {
        log("getCurrentSession", "result", { result, provider: p.name });
        return result;
      }
    }
    log("getCurrentSession", "no provider returned a session");
    return null;
  }

  /** If any pane agent is alive for this session, override terminal agentState to waiting. */
  function overrideTerminalIfPaneAlive(
    sessionName: string,
    state: AgentEvent | null,
  ): AgentEvent | null {
    if (!state || !TERMINAL_STATUSES.has(state.status)) return state;
    const paneAgents = paneAgentsBySession.get(sessionName);
    if (!paneAgents || paneAgents.size === 0) return state;
    for (const presence of paneAgents.values()) {
      if (presence.agent === state.agent && presence.threadId === state.threadId) {
        return { ...state, status: "waiting" };
      }
    }
    return state;
  }

  /** Merge pane-detected agents into watcher-provided agents for a session.
   *  Watcher events take precedence — pane presence only adds synthetic entries
   *  for agents that aren't already tracked by watchers. */
  function mergeAgentsWithPanePresence(
    sessionName: string,
    watcherAgents: AgentEvent[],
  ): AgentEvent[] {
    const paneAgents = paneAgentsBySession.get(sessionName);

    // Drop agents whose pane has closed. Tracker only prunes terminals on a
    // timeout, so non-terminal agents (waiting/running/question) would otherwise
    // linger forever after their tmux pane is killed.
    const liveWatcherAgents = watcherAgents.filter((a) => {
      if (!a.paneId) return true;
      if (TERMINAL_STATUSES.has(a.status)) return true;
      return paneAgents?.has(instanceKey(a.agent, a.threadId)) ?? false;
    });

    if (!paneAgents || paneAgents.size === 0) return liveWatcherAgents;

    const result = [...liveWatcherAgents];
    const trackedByKey = new Map(result.map((a, i) => [instanceKey(a.agent, a.threadId), i]));

    for (const [, presence] of paneAgents) {
      const key = instanceKey(presence.agent, presence.threadId);
      const trackedIdx = trackedByKey.get(key);

      if (trackedIdx != null) {
        // Watcher already tracks this agent — process is confirmed alive,
        // so terminal journal status means it's waiting for user input.
        const tracked = result[trackedIdx]!;
        if (TERMINAL_STATUSES.has(tracked.status)) {
          tracked.status = "waiting";
          tracked.paneId = presence.paneId;
        }
        continue;
      }

      // If we have no threadId from pane scan and watcher tracks any instance of this agent, skip
      if (!presence.threadId && watcherAgents.some((a) => a.agent === presence.agent)) continue;

      result.push({
        agent: presence.agent,
        session: sessionName,
        status: presence.status ?? "idle",
        ts: presence.lastSeenTs,
        threadId: presence.threadId,
        threadName: presence.threadName,
        paneId: presence.paneId,
      });
    }

    return result;
  }

  function computeState(): ServerState {
    // Merge sessions from all providers
    const allMuxSessions: (import("../contracts/mux").MuxSessionInfo & {
      provider: MuxProvider;
    })[] = [];
    for (const p of allProviders) {
      for (const s of p.listSessions()) {
        allMuxSessions.push({ ...s, provider: p });
      }
    }
    allMuxSessions.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.name.localeCompare(b.name);
    });

    // Sync custom ordering with current session list
    sessionOrder.sync(allMuxSessions.map((s) => s.name));

    // Apply custom ordering
    const orderedNames = sessionOrder.apply(allMuxSessions.map((s) => s.name));
    const sessionByName = new Map(allMuxSessions.map((s) => [s.name, s]));
    const orderedMuxSessions = orderedNames.map((n) => sessionByName.get(n)!);

    // Batch pane counts per provider (uses BatchCapable type guard)
    const paneCountMaps = new Map<MuxProvider, Map<string, number>>();
    for (const p of allProviders) {
      if (isBatchCapable(p)) {
        paneCountMaps.set(p, p.getAllPaneCounts());
      }
    }

    const sessions: SessionData[] = orderedMuxSessions.map(
      ({ name, createdAt, windows, dir, provider }) => {
        sessionProviders.set(name, provider);
        const git = getGitInfo(dir);
        const providerPaneCounts = paneCountMaps.get(provider);
        const panes = providerPaneCounts?.get(name) ?? provider.getPaneCount(name);

        return {
          name,
          createdAt,
          dir,
          branch: git.branch,
          isWorktree: git.isWorktree,
          filesChanged: git.filesChanged,
          linesAdded: git.linesAdded,
          linesRemoved: git.linesRemoved,
          commitsDelta: git.commitsDelta,
          unseen: tracker.isUnseen(name),
          panes,
          ports: getSessionPorts(name),
          windows,
          uptime: formatUptime(createdAt),
          agentState: overrideTerminalIfPaneAlive(name, tracker.getState(name)),
          agents: mergeAgentsWithPanePresence(name, tracker.getAgents(name)),
          eventTimestamps: tracker.getEventTimestamps(name),
          metadata: metadataStore.get(name),
        };
      },
    );

    metadataStore.pruneSessions(new Set(sessions.map((s) => s.name)));

    const liveDirs = new Set(
      sessions.map((s) => {
        try {
          return realpathSync(s.dir);
        } catch {
          return s.dir;
        }
      }),
    );
    const slots: SlotInfo[] = [];
    for (const dir of config.repoSlots ?? []) {
      let resolved = dir;
      try {
        resolved = realpathSync(dir);
      } catch {
        continue; // configured slot no longer exists on disk
      }
      if (liveDirs.has(resolved)) continue;
      const git = getGitInfo(resolved);
      slots.push({
        dir: resolved,
        name: basename(resolved),
        branch: git.branch,
        isWorktree: git.isWorktree,
        filesChanged: git.filesChanged,
        linesAdded: git.linesAdded,
        linesRemoved: git.linesRemoved,
        commitsDelta: git.commitsDelta,
      });
    }

    return {
      type: "state",
      sessions,
      slots,
      theme: currentTheme,
      sidebarWidth,
      preferredEditor,
      ts: Date.now(),
    };
  }

  let broadcastPending = false;

  function broadcastState() {
    if (broadcastPending) return;
    broadcastPending = true;
    queueMicrotask(() => {
      broadcastPending = false;
      broadcastStateImmediate();
    });
  }

  function broadcastStateImmediate() {
    tracker.pruneStuck(STUCK_RUNNING_TIMEOUT_MS);
    tracker.pruneTerminal();
    tracker.pruneStale(STALE_AGENT_TIMEOUT_MS);
    tracker.pruneIdle(IDLE_PRUNE_MS);
    tracker.pruneSupersededByPane();
    lastState = computeState();
    syncGitWatchers([...lastState.sessions, ...lastState.slots], broadcastState);
    const msg = JSON.stringify(lastState);
    server.publish("sidebar", msg);
  }

  /** Tell TUIs a client is now viewing `name` — they use it to reset their
   * local pending-switch marker. Card selection is per-TUI: with multiple
   * terminals attached there is no one true "focused session" the server
   * could own. `select` is the handoff exception — a sidebar action switched
   * the viewer to another session's sidebar, and that destination sidebar
   * should highlight what was clicked. */
  function publishSessionViewed(name: string, select?: SessionViewed["select"]) {
    const msg: SessionViewed = { type: "session-viewed", name, select };
    server.publish("sidebar", JSON.stringify(msg));
  }

  function handleFocus(name: string): void {
    // Rescan pane agents when a client moves to another session
    refreshPaneAgents();
    const hadUnseen = tracker.handleFocus(name);
    if (hadUnseen && lastState) {
      // Patch unseen flags in-place — avoids a full computeState with many subprocesses
      const updatedSessions = lastState.sessions.map((s) => {
        if (s.name !== name) return s;
        return {
          ...s,
          unseen: false,
          agents: s.agents.map((a) => ({ ...a, unseen: false })),
        };
      });
      lastState = { ...lastState, sessions: updatedSessions };
      server.publish("sidebar", JSON.stringify(lastState));
    } else if (hadUnseen) {
      broadcastState();
    }
    publishSessionViewed(name);
  }

  function switchToVisibleIndex(index: number, target?: SwitchTarget): void {
    if (!lastState) {
      broadcastState();
    }

    if (!lastState) return;

    const idx = index - 1;
    if (idx < 0 || idx >= lastState.sessions.length) return;

    const name = lastState.sessions[idx]!.name;
    const p = sessionProviders.get(name) ?? mux;
    p.switchSession(name, target);
  }

  // --- Sidebar management ---

  function getProvidersWithSidebar() {
    return allProviders.filter(isFullSidebarCapable);
  }

  /** Strip surrounding whitespace and quote characters from a POST body. */
  function unquoteBody(body: string): string {
    return body
      .trim()
      .replace(/^"+|"+$/g, "")
      .replace(/^'+|'+$/g, "");
  }

  /** Parse "clientTty|session|windowId" or legacy "session:windowId" context from POST body */
  function parseContext(
    body: string,
  ): { clientTty?: string; session: string; windowId: string } | null {
    const trimmed = unquoteBody(body);

    // New format: pipe-separated "clientTty|session|windowId"
    const pipeParts = trimmed.split("|");
    if (pipeParts.length === 3 && pipeParts[1] && pipeParts[2]) {
      return {
        clientTty: pipeParts[0] || undefined,
        session: pipeParts[1],
        windowId: pipeParts[2],
      };
    }

    // Legacy format: "session:windowId"
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 1) return null;
    const session = trimmed.slice(0, colonIdx);
    const windowId = trimmed.slice(colonIdx + 1);
    if (!session || !windowId) return null;
    return { session, windowId };
  }

  function parseResizeContext(body: string): SidebarResizeContext | null {
    const trimmed = unquoteBody(body);
    if (!trimmed) return null;

    const [paneId, sessionName, windowId, widthRaw, windowWidthRaw] = trimmed.split("|");
    if (!paneId) return null;

    const width = Number.parseInt(widthRaw ?? "", 10);
    const windowWidth = Number.parseInt(windowWidthRaw ?? "", 10);

    return {
      paneId,
      sessionName: sessionName || undefined,
      windowId: windowId || undefined,
      width: Number.isNaN(width) ? undefined : width,
      windowWidth: Number.isNaN(windowWidth) ? undefined : windowWidth,
    };
  }

  // Short-lived cache for sidebar pane listings — avoid repeated tmux list-panes -a
  let sidebarPaneCache: ReturnType<typeof listSidebarPanesByProviderUncached> | null = null;
  let sidebarPaneCacheTs = 0;
  const SIDEBAR_PANE_CACHE_TTL = 300; // ms

  function listSidebarPanesByProviderUncached() {
    return getProvidersWithSidebar().map((provider) => ({
      provider,
      panes: provider.listSidebarPanes(),
    }));
  }

  function listSidebarPanesByProvider() {
    const now = Date.now();
    if (sidebarPaneCache && now - sidebarPaneCacheTs < SIDEBAR_PANE_CACHE_TTL)
      return sidebarPaneCache;
    sidebarPaneCache = listSidebarPanesByProviderUncached();
    sidebarPaneCacheTs = now;
    return sidebarPaneCache;
  }

  function invalidateSidebarPaneCache(): void {
    sidebarPaneCache = null;
    sidebarPaneCacheTs = 0;
  }

  const pendingSidebarSpawns = new Set<string>();
  const suppressedSidebarResizeAcks = new Map<string, SidebarResizeSuppression>();
  const sidebarWindowResizeCooldown = new Map<string, number>();
  let sidebarSnapshots = new Map<string, { width?: number; windowWidth?: number }>();
  let pendingSidebarResize: ReturnType<typeof setTimeout> | null = null;

  function scheduleSidebarResize(ctx?: SidebarResizeContext): void {
    resizeSidebars(ctx);
    if (pendingSidebarResize) clearTimeout(pendingSidebarResize);
    // tmux can finish layout changes slightly after the pane appears.
    pendingSidebarResize = setTimeout(() => {
      pendingSidebarResize = null;
      resizeSidebars();
    }, 120);
  }

  function toggleSidebar(ctx?: { session: string; windowId: string }): void {
    const providers = getProvidersWithSidebar();
    if (providers.length === 0) {
      log("toggle", "SKIP — no providers with sidebar methods");
      return;
    }

    invalidateSidebarPaneCache();
    if (sidebarVisible) {
      for (const p of providers) {
        const panes = p.listSidebarPanes();
        log("toggle", "OFF — hiding panes", { provider: p.name, count: panes.length });
        for (const pane of panes) {
          p.hideSidebar(pane.paneId);
        }
      }
      sidebarVisible = false;
    } else {
      sidebarVisible = true;
      for (const p of providers) {
        const allWindows = p.listActiveWindows();
        log("toggle", "ON — spawning in active windows", {
          provider: p.name,
          count: allWindows.length,
        });
        for (const w of allWindows) {
          ensureSidebarInWindow(p, { session: w.sessionName, windowId: w.id });
        }
      }
      scheduleSidebarResize();
      server.publish("sidebar", JSON.stringify({ type: "re-identify" }));
    }
    log("toggle", "done", { sidebarVisible });
  }

  function ensureSidebarInWindow(
    provider?: ReturnType<typeof getProvidersWithSidebar>[number],
    ctx?: { session: string; windowId: string },
  ): void {
    // If no specific provider, try to find one for the session
    const p =
      provider ??
      (() => {
        const providers = getProvidersWithSidebar();
        if (ctx?.session) {
          const sessionProvider = sessionProviders.get(ctx.session);
          return providers.find((pp) => pp === sessionProvider) ?? providers[0];
        }
        return providers[0];
      })();
    if (!p || !sidebarVisible) {
      log("ensure", "SKIP", { hasProvider: !!p, sidebarVisible });
      return;
    }

    const curSession = ctx?.session ?? getCurrentSession();
    if (!curSession) {
      log("ensure", "SKIP — no current session");
      return;
    }

    const windowId = ctx?.windowId ?? p.getCurrentWindowId();
    if (!windowId) {
      log("ensure", "SKIP — could not get window_id");
      return;
    }

    const spawnKey = `${p.name}:${windowId}`;
    if (pendingSidebarSpawns.has(spawnKey)) {
      log("ensure", "SKIP — spawn already in progress", { curSession, windowId, provider: p.name });
      return;
    }

    // Use cached pane listing to avoid redundant tmux list-panes -a calls
    const allPanesByProvider = listSidebarPanesByProvider();
    const providerEntry = allPanesByProvider.find((e) => e.provider === p);
    const existingPanes = providerEntry?.panes ?? [];
    const hasInWindow = existingPanes.some((ep) => ep.windowId === windowId);
    log("ensure", "checking window", {
      curSession,
      windowId,
      existingPanes: existingPanes.length,
      hasInWindow,
      paneIds: existingPanes.map((x) => `${x.paneId}@${x.windowId}`),
    });

    if (!hasInWindow) {
      invalidateSidebarPaneCache();
      pendingSidebarSpawns.add(spawnKey);
      log("ensure", "SPAWNING sidebar", {
        curSession,
        windowId,
        sidebarWidth,
        sidebarPosition,
      });
      try {
        const newPaneId = p.spawnSidebar(curSession, windowId, sidebarWidth, sidebarPosition);
        log("ensure", "spawn result", { newPaneId });
        // Do NOT refocus the main pane here — the TUI handles it.
        // For fresh spawns, the TUI refocuses after capability detection.
        // For stash restores, the TUI refocuses after restoreTerminalModes
        // responses settle. Refocusing immediately from the server causes
        // capability query responses to leak as garbage escape sequences.
      } finally {
        pendingSidebarSpawns.delete(spawnKey);
      }
      // Only schedule resize when we actually spawned — layout changed
      scheduleSidebarResize();
    }
    // When sidebar already exists, no layout change — skip resize
  }

  // Debounced ensure-sidebar — collapses rapid hook-fired calls during fast
  // session switching into a single check after switching settles. Pending
  // contexts are keyed by window so near-simultaneous calls for different
  // windows (e.g. restart bootstrapping one per attached client) each get
  // ensured instead of last-write-wins dropping all but one.
  let ensureSidebarTimer: ReturnType<typeof setTimeout> | null = null;
  const ensureSidebarPendingCtxs = new Map<string, { session: string; windowId: string }>();
  let ensureSidebarPendingNoCtx = false;

  function debouncedEnsureSidebar(ctx?: { session: string; windowId: string }): void {
    if (ctx) ensureSidebarPendingCtxs.set(ctx.windowId, ctx);
    else ensureSidebarPendingNoCtx = true;
    if (ensureSidebarTimer) clearTimeout(ensureSidebarTimer);
    ensureSidebarTimer = setTimeout(() => {
      ensureSidebarTimer = null;
      const ctxs = [...ensureSidebarPendingCtxs.values()];
      ensureSidebarPendingCtxs.clear();
      const noCtx = ensureSidebarPendingNoCtx;
      ensureSidebarPendingNoCtx = false;
      if (ctxs.length === 0 && noCtx) {
        ensureSidebarInWindow(undefined, undefined);
        return;
      }
      for (const c of ctxs) ensureSidebarInWindow(undefined, c);
    }, 150);
  }

  function quitAll(): void {
    log("quit", "killing all sidebar panes");
    for (const p of getProvidersWithSidebar()) {
      const panes = p.listSidebarPanes();
      log("quit", "found panes to kill", { provider: p.name, count: panes.length });
      for (const pane of panes) {
        p.killSidebarPane(pane.paneId);
      }
    }
    // Provider-specific cleanup (uses type guard)
    for (const p of getProvidersWithSidebar()) {
      p.cleanupSidebar();
    }
    server.publish("sidebar", JSON.stringify({ type: "quit" }));
    sidebarVisible = false;
    cleanup();
    process.exit(0);
  }

  // --- Sidebar resize enforcement ---

  function resizeSidebars(ctx?: SidebarResizeContext) {
    if (ctx?.paneId) invalidateSidebarPaneCache();
    const panesByProvider = listSidebarPanesByProvider();
    const allPanes = panesByProvider.flatMap(({ panes }) => panes);

    if (allPanes.length === 0) {
      sidebarSnapshots = new Map();
      return;
    }

    const nextSidebarWidth = resolveSidebarWidthFromResizeContext({
      ctx,
      panes: allPanes,
      previousByWindow: sidebarSnapshots,
      suppressedByPane: suppressedSidebarResizeAcks,
      windowResizeCooldown: sidebarWindowResizeCooldown,
    });

    if (nextSidebarWidth != null && nextSidebarWidth !== sidebarWidth) {
      sidebarWidth = nextSidebarWidth;
      saveConfig({ sidebarWidth });
      log("resize", "adopted sidebar width from pane resize", {
        paneId: ctx?.paneId ?? null,
        sessionName: ctx?.sessionName ?? null,
        windowId: ctx?.windowId ?? null,
        sidebarWidth,
      });
      broadcastState();
    }

    const now = Date.now();
    for (const { provider, panes } of panesByProvider) {
      log("resize", "enforcing width on all panes", {
        provider: provider.name,
        sidebarWidth,
        count: panes.length,
        triggerPaneId: ctx?.paneId ?? null,
      });
      for (const pane of panes) {
        if (pane.width === sidebarWidth) continue;
        suppressedSidebarResizeAcks.set(pane.paneId, {
          width: sidebarWidth,
          expiresAt: now + 1_000,
        });
        provider.resizeSidebarPane(pane.paneId, sidebarWidth);
      }
    }

    // After resizing, invalidate the sidebar pane cache since widths changed,
    // and use the already-fetched list for the snapshot (avoid another tmux call).
    if (panesByProvider.some(({ panes }) => panes.some((pane) => pane.width !== sidebarWidth))) {
      invalidateSidebarPaneCache();
    }
    sidebarSnapshots = snapshotSidebarWindows(allPanes);
  }

  // --- Focus agent pane (click-to-focus from TUI) ---

  const AGENT_TITLE_PATTERNS: Record<string, string[]> = {
    amp: ["amp"],
    "claude-code": ["claude"],
    codex: ["codex"],
    opencode: ["opencode"],
  };

  const PANE_HIGHLIGHT_BORDER = "fg=#fab387,bold";
  const PANE_HIGHLIGHT_MS = 300;
  const pendingHighlightResets = new Map<string, ReturnType<typeof setTimeout>>();

  type PaneEntry = { id: string; pid: number; cmd: string; title: string };
  type ProcessTree = ReturnType<typeof buildProcessTree>;

  /** Claude Code: ~/.claude/sessions/<pid>.json → sessionId */
  function resolveClaudeCodePane(
    panes: PaneEntry[],
    threadId: string,
    tree: ProcessTree,
  ): string | undefined {
    const sessionsDir = join(homedir(), ".claude", "sessions");
    for (const pane of panes) {
      const agentPid = findChildPidFast(pane.pid, "claude", tree);
      if (!agentPid) continue;
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, `${agentPid}.json`), "utf-8"));
        if (data.sessionId === threadId) return pane.id;
      } catch {
        // intentionally ignored: Claude session file missing or malformed — try next pane
      }
    }
    return undefined;
  }

  /** Codex: logs_1.sqlite process_uuid='pid:<PID>:*' → thread_id */
  function resolveCodexPane(
    panes: PaneEntry[],
    threadId: string,
    tree: ProcessTree,
  ): string | undefined {
    const dbPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "logs_1.sqlite");
    let db: any;
    try {
      const { Database } = require("bun:sqlite");
      db = new Database(dbPath, { readonly: true });
    } catch {
      return undefined;
    }

    try {
      for (const pane of panes) {
        const agentPid = findChildPidFast(pane.pid, "codex", tree);
        if (!agentPid) continue;
        const row = db
          .query(
            `SELECT thread_id FROM logs WHERE process_uuid LIKE ? AND thread_id IS NOT NULL ORDER BY ts DESC LIMIT 1`,
          )
          .get(`pid:${agentPid}:%`);
        if (row?.thread_id === threadId) return pane.id;
      }
    } finally {
      try {
        db.close();
      } catch {
        // intentionally ignored: best-effort sqlite handle cleanup
      }
    }
    return undefined;
  }

  /** OpenCode: lsof → log file → grep session ID */
  function resolveOpenCodePane(
    panes: PaneEntry[],
    threadId: string,
    tree: ProcessTree,
  ): string | undefined {
    for (const pane of panes) {
      const agentPid = findChildPidFast(pane.pid, "opencode", tree);
      if (!agentPid) continue;
      const lsofOut = shell(["lsof", "-p", String(agentPid)]);
      if (!lsofOut) continue;
      // Find the log file path from open file descriptors
      const logLine = lsofOut
        .split("\n")
        .find((l) => l.includes("/opencode/log/") && l.endsWith(".log"));
      if (!logLine) continue;
      // Extract absolute path — lsof NAME column starts at the last recognized path
      const pathMatch = logLine.match(/\s(\/\S+\.log)$/);
      if (!pathMatch) continue;
      try {
        const logText = readFileSync(pathMatch[1], "utf-8");
        const match = logText.match(/ses_[A-Za-z0-9]+/);
        if (match?.[0] === threadId) return pane.id;
      } catch {
        // intentionally ignored: OpenCode log file unreadable — try next pane
      }
    }
    return undefined;
  }

  /** Resolve a tmux pane ID for an agent using all available resolution strategies. */
  function resolveAgentPaneId(
    sessionName: string,
    agentName: string,
    threadId?: string,
    threadName?: string,
  ): string | undefined {
    const p = sessionProviders.get(sessionName) ?? mux;
    if (p.name !== "tmux") return undefined;

    const patterns = AGENT_TITLE_PATTERNS[agentName];
    if (!patterns) return undefined;

    const raw = shell([
      "tmux",
      "list-panes",
      "-s",
      "-t",
      sessionName,
      "-F",
      "#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_title}",
    ]);
    if (!raw) return undefined;

    const panes: PaneEntry[] = raw.split("\n").map((line) => {
      const idx1 = line.indexOf("|");
      const idx2 = line.indexOf("|", idx1 + 1);
      const idx3 = line.indexOf("|", idx2 + 1);
      return {
        id: line.slice(0, idx1),
        pid: Number.parseInt(line.slice(idx1 + 1, idx2), 10),
        cmd: line.slice(idx2 + 1, idx3),
        title: line.slice(idx3 + 1),
      };
    });

    const sidebarPaneIds = new Set<string>();
    for (const { panes: sbPanes } of listSidebarPanesByProvider()) {
      for (const sb of sbPanes) sidebarPaneIds.add(sb.paneId);
    }
    const nonSidebar = panes.filter((p) => !sidebarPaneIds.has(p.id));

    // One ps snapshot for all panes — same fast path as the periodic scan,
    // instead of recursive pgrep/ps per child per pane.
    const tree = buildProcessTree();

    let targetPaneId: string | undefined;

    if (agentName === "claude-code" && threadId) {
      targetPaneId = resolveClaudeCodePane(nonSidebar, threadId, tree);
    }
    if (!targetPaneId && agentName === "amp" && threadName) {
      targetPaneId = nonSidebar.find(
        (p) => p.title.toLowerCase().startsWith("amp - ") && p.title.includes(threadName),
      )?.id;
    }
    if (!targetPaneId && agentName === "codex" && threadId) {
      targetPaneId = resolveCodexPane(nonSidebar, threadId, tree);
    }
    if (!targetPaneId && agentName === "opencode" && threadId) {
      targetPaneId = resolveOpenCodePane(nonSidebar, threadId, tree);
    }
    if (!targetPaneId) {
      targetPaneId = nonSidebar.find((p) =>
        patterns.some((pat) => p.title.toLowerCase().includes(pat)),
      )?.id;
    }
    if (!targetPaneId) {
      for (const pane of nonSidebar) {
        if (matchProcessTreeFast(pane.pid, patterns, tree)) {
          targetPaneId = pane.id;
          break;
        }
      }
    }
    return targetPaneId;
  }

  /** Ttys of clients currently attached to `fromSession` — the clients whose
   * sidebar initiated an action and should therefore be the ones switched. */
  function listAttachedClientTtys(fromSession: string | undefined): string[] {
    if (!fromSession) return [];
    const out = shell(["tmux", "list-clients", "-F", "#{client_tty}|#{client_session}"]);
    if (!out) return [];
    const clients = out
      .split("\n")
      .map((line) => {
        const [tty, sessionName] = line.split("|");
        return { tty: tty ?? "", sessionName: sessionName ?? "" };
      })
      .filter((c) => c.tty);
    return resolveSwitchTargets(clients, fromSession);
  }

  /** Sessions that currently have at least one attached client (deduped). */
  function listAttachedClientSessions(): string[] {
    const out = shell(["tmux", "list-clients", "-F", "#{client_session}"]);
    if (!out) return [];
    return [...new Set(out.split("\n").filter(Boolean))];
  }

  /** Returns true when a pane was resolved and the viewer was switched to it. */
  function focusAgentPane(
    sessionName: string,
    agentName: string,
    threadId?: string,
    threadName?: string,
    fromSession?: string,
  ): boolean {
    log("focus-agent-pane", "received", {
      sessionName,
      agentName,
      threadId,
      threadName,
      fromSession,
    });
    const targetPaneId = resolveAgentPaneId(sessionName, agentName, threadId, threadName);
    if (!targetPaneId) return false;

    log("focus-agent-pane", "focusing", { sessionName, agentName, paneId: targetPaneId });
    // The agent's pane may live in a different session/window than the one the
    // client is attached to. switch-client moves the active client to the
    // agent's session, select-window to its window, select-pane to the pane.
    // Switch the client(s) attached to the sidebar's own session — resolved at
    // action time, so a multi-terminal setup moves the terminal that was
    // clicked in, not whichever client happens to be most-recently-active.
    const ttys = listAttachedClientTtys(fromSession);
    if (ttys.length === 0) {
      shell(["tmux", "switch-client", "-t", sessionName]);
    } else {
      for (const tty of ttys) {
        shell(["tmux", "switch-client", "-c", tty, "-t", sessionName]);
      }
    }
    shell(["tmux", "select-window", "-t", targetPaneId]);
    shell(["tmux", "select-pane", "-t", targetPaneId]);

    const existing = pendingHighlightResets.get(targetPaneId);
    if (existing) clearTimeout(existing);

    shell([
      "tmux",
      "set-option",
      "-p",
      "-t",
      targetPaneId,
      "pane-active-border-style",
      PANE_HIGHLIGHT_BORDER,
    ]);
    shell(["tmux", "select-pane", "-t", targetPaneId, "-P", "bg=#2a2a4a"]);
    pendingHighlightResets.set(
      targetPaneId,
      setTimeout(() => {
        shell(["tmux", "set-option", "-p", "-t", targetPaneId, "-u", "pane-active-border-style"]);
        shell(["tmux", "select-pane", "-t", targetPaneId, "-P", ""]);
        pendingHighlightResets.delete(targetPaneId);
      }, PANE_HIGHLIGHT_MS),
    );
    return true;
  }

  function killAgentPane(
    sessionName: string,
    agentName: string,
    threadId?: string,
    threadName?: string,
  ): void {
    log("kill-agent-pane", "received", { sessionName, agentName, threadId, threadName });
    const targetPaneId = resolveAgentPaneId(sessionName, agentName, threadId, threadName);
    if (!targetPaneId) return;

    log("kill-agent-pane", "killing", { sessionName, agentName, paneId: targetPaneId });
    shell(["tmux", "kill-pane", "-t", targetPaneId]);
  }

  // --- Pane agent scanning (detect agents running in current session panes) ---

  interface PaneAgentPresence {
    agent: string;
    session: string;
    paneId: string;
    threadId?: string;
    threadName?: string;
    status?: import("../contracts/agent").AgentStatus;
    lastSeenTs: number;
  }

  // Pane agent presence per session: sessionName → Map<instanceKey, PaneAgentPresence>
  let paneAgentsBySession = new Map<string, Map<string, PaneAgentPresence>>();

  /** Build parent→children map from a single ps snapshot (avoids per-pane pgrep calls). */
  function buildProcessTree(): { childrenOf: Map<number, number[]>; commOf: Map<number, string> } {
    const childrenOf = new Map<number, number[]>();
    const commOf = new Map<number, string>();
    const psResult = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,comm="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const line of psResult.stdout.toString().trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number.parseInt(parts[0], 10);
      const ppid = Number.parseInt(parts[1], 10);
      const comm = parts.slice(2).join(" ").toLowerCase();
      if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
      commOf.set(pid, comm);
      let arr = childrenOf.get(ppid);
      if (!arr) {
        arr = [];
        childrenOf.set(ppid, arr);
      }
      arr.push(pid);
    }
    return { childrenOf, commOf };
  }

  /** Walk up to 3 levels of child processes using a pre-built process tree. */
  function matchProcessTreeFast(
    pid: number,
    patterns: string[],
    tree: ReturnType<typeof buildProcessTree>,
    depth = 0,
  ): boolean {
    if (depth > 2) return false;
    const children = tree.childrenOf.get(pid);
    if (!children) return false;
    for (const childPid of children) {
      const comm = tree.commOf.get(childPid);
      if (comm && patterns.some((pat) => comm.includes(pat))) return true;
      if (matchProcessTreeFast(childPid, patterns, tree, depth + 1)) return true;
    }
    return false;
  }

  /** Find child PID matching a name pattern using pre-built process tree. */
  function findChildPidFast(
    pid: number,
    name: string,
    tree: ReturnType<typeof buildProcessTree>,
    depth = 0,
  ): number | undefined {
    if (depth > 2) return undefined;
    const children = tree.childrenOf.get(pid);
    if (!children) return undefined;
    for (const childPid of children) {
      const comm = tree.commOf.get(childPid);
      if (comm?.includes(name)) return childPid;
      const found = findChildPidFast(childPid, name, tree, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  /** Resolve threadId/threadName for an amp pane from its title. */
  function resolveAmpPaneInfo(title: string): { threadId?: string; threadName?: string } {
    // Amp pane title format: "amp - <threadName> - <dir>"
    if (!title.toLowerCase().startsWith("amp - ")) return {};
    const rest = title.slice(6);
    const dashIdx = rest.lastIndexOf(" - ");
    const threadName = dashIdx > 0 ? rest.slice(0, dashIdx) : rest;
    return { threadName: threadName || undefined };
  }

  /** Resolve threadId/threadName/status for a Claude Code pane via ~/.claude/sessions/<pid>.json + journal. */
  function resolveClaudeCodePaneInfo(
    panePid: number,
    tree: ReturnType<typeof buildProcessTree>,
  ): { threadId?: string; threadName?: string; status?: import("../contracts/agent").AgentStatus } {
    const agentPid = findChildPidFast(panePid, "claude", tree);
    if (!agentPid) return {};
    const sessionsDir = join(homedir(), ".claude", "sessions");
    try {
      const data = JSON.parse(readFileSync(join(sessionsDir, `${agentPid}.json`), "utf-8"));
      const threadId: string | undefined = data.sessionId;
      if (!threadId) return {};
      const journalInfo = resolveClaudeCodeJournalInfo(threadId);
      // Process is alive (found via process tree), so terminal journal status
      // means it's waiting for user input.
      if (journalInfo.status && TERMINAL_STATUSES.has(journalInfo.status)) {
        journalInfo.status = "waiting";
      }
      return { threadId, ...journalInfo };
    } catch {
      return {};
    }
  }

  /** Read the JSONL journal to extract thread name and current status. */
  function resolveClaudeCodeJournalInfo(threadId: string): {
    threadName?: string;
    status?: import("../contracts/agent").AgentStatus;
  } {
    const projectsDir = join(homedir(), ".claude", "projects");
    try {
      const dirs = require("node:fs").readdirSync(projectsDir) as string[];
      for (const dir of dirs) {
        const filePath = join(projectsDir, dir, `${threadId}.jsonl`);
        try {
          const text = readFileSync(filePath, "utf-8");
          const lines = text.split("\n").filter(Boolean);
          let threadName: string | undefined;
          let lastStatus: import("../contracts/agent").AgentStatus = "idle";

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const msg = entry.message;
              if (!msg?.role) continue;

              // Extract thread name from first user message
              if (!threadName && msg.role === "user") {
                const content = msg.content;
                let t: string | undefined;
                if (typeof content === "string") t = content;
                else if (Array.isArray(content))
                  t = content.find((c: any) => c.type === "text" && c.text)?.text;
                if (t && !t.startsWith("<") && !t.startsWith("{")) threadName = t.slice(0, 80);
              }

              if (msg.role === "assistant") {
                const items = Array.isArray(msg.content) ? msg.content : [];
                const toolUses = items.filter((c: any) => c.type === "tool_use");
                if (toolUses.length === 0) {
                  lastStatus = "done";
                } else {
                  lastStatus = toolUses.every((c: any) => c.name === "AskUserQuestion")
                    ? "question"
                    : "running";
                }
              } else if (msg.role === "user") {
                lastStatus = "running";
              }
            } catch {
              continue;
            }
          }

          return { threadName, status: lastStatus };
        } catch {
          continue;
        }
      }
    } catch {
      // intentionally ignored: Claude projects dir missing or unreadable
    }
    return {};
  }

  /** Resolve threadId for a Codex pane via logs_1.sqlite. */
  function resolveCodexPaneInfo(
    panePid: number,
    tree: ReturnType<typeof buildProcessTree>,
  ): { threadId?: string; threadName?: string } {
    const agentPid = findChildPidFast(panePid, "codex", tree);
    if (!agentPid) return {};
    const dbPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "logs_1.sqlite");
    let db: any;
    try {
      const { Database } = require("bun:sqlite");
      db = new Database(dbPath, { readonly: true });
    } catch {
      return {};
    }
    try {
      const row = db
        .query(
          `SELECT thread_id FROM logs WHERE process_uuid LIKE ? AND thread_id IS NOT NULL ORDER BY ts DESC LIMIT 1`,
        )
        .get(`pid:${agentPid}:%`);
      if (row?.thread_id) return { threadId: row.thread_id };
    } catch {
      // intentionally ignored: Codex sqlite query failed — no thread info available
    } finally {
      try {
        db.close();
      } catch {
        // intentionally ignored: best-effort sqlite handle cleanup
      }
    }
    return {};
  }

  /** Scan all panes across all tmux sessions and identify running agents.
   *  Uses a single `tmux list-panes -a` call for efficiency. */
  function scanAllTmuxPaneAgents(): Map<string, Map<string, PaneAgentPresence>> {
    const result = new Map<string, Map<string, PaneAgentPresence>>();

    const raw = shell([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{session_name}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_title}",
    ]);
    if (!raw) return result;

    const panes = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const idx1 = line.indexOf("|");
        const idx2 = line.indexOf("|", idx1 + 1);
        const idx3 = line.indexOf("|", idx2 + 1);
        const idx4 = line.indexOf("|", idx3 + 1);
        return {
          session: line.slice(0, idx1),
          id: line.slice(idx1 + 1, idx2),
          pid: Number.parseInt(line.slice(idx2 + 1, idx3), 10),
          cmd: line.slice(idx3 + 1, idx4),
          title: line.slice(idx4 + 1),
        };
      });

    // Exclude sidebar panes
    const sidebarPaneIds = new Set<string>();
    for (const { panes: sbPanes } of listSidebarPanesByProvider()) {
      for (const sb of sbPanes) sidebarPaneIds.add(sb.paneId);
    }

    const nonSidebar = panes.filter((p) => !sidebarPaneIds.has(p.id));
    if (nonSidebar.length === 0) return result;

    // Build process tree once for all panes
    const tree = buildProcessTree();
    const now = Date.now();

    for (const pane of nonSidebar) {
      for (const [agentName, patterns] of Object.entries(AGENT_TITLE_PATTERNS)) {
        // Only use process tree matching — title matching produces false positives
        // (e.g. an Amp thread named "Detect Claude session names" matches "claude")
        if (!matchProcessTreeFast(pane.pid, patterns, tree)) continue;

        let threadId: string | undefined;
        let threadName: string | undefined;
        let status: import("../contracts/agent").AgentStatus | undefined;

        // Resolve thread info per agent type
        if (agentName === "amp") {
          const info = resolveAmpPaneInfo(pane.title);
          threadName = info.threadName;
        } else if (agentName === "claude-code") {
          const info = resolveClaudeCodePaneInfo(pane.pid, tree);
          threadId = info.threadId;
          threadName = info.threadName;
          status = info.status;
        } else if (agentName === "codex") {
          const info = resolveCodexPaneInfo(pane.pid, tree);
          threadId = info.threadId;
        }

        const key = `${agentName}:pane:${pane.id}`;
        let sessionAgents = result.get(pane.session);
        if (!sessionAgents) {
          sessionAgents = new Map();
          result.set(pane.session, sessionAgents);
        }
        sessionAgents.set(key, {
          agent: agentName,
          session: pane.session,
          paneId: pane.id,
          threadId,
          threadName,
          status,
          lastSeenTs: now,
        });
      }
    }

    return result;
  }

  /** Refresh pane agent cache for all tmux sessions. */
  function refreshPaneAgents(): void {
    // Check if any provider is tmux
    const hasTmux = allProviders.some((p) => p.name === "tmux");
    if (!hasTmux) {
      if (paneAgentsBySession.size > 0) {
        paneAgentsBySession.clear();
        tracker.setPinnedInstancesMulti(new Map());
        broadcastState();
      }
      return;
    }

    const nextBySession = scanAllTmuxPaneAgents();
    const allPinnedKeys = new Map<string, string[]>();
    for (const [session, agents] of nextBySession) {
      allPinnedKeys.set(session, [...agents.keys()]);
    }

    const changed = paneAgentSetsDiffer(paneAgentsBySession, nextBySession);
    paneAgentsBySession = nextBySession;

    // Update tracker pinning for all sessions
    tracker.setPinnedInstancesMulti(allPinnedKeys);

    if (changed) broadcastState();
  }

  // --- Pane agent polling (detect agents in current session every 3s) ---

  const PANE_SCAN_INTERVAL_MS = 3_000;
  let paneScanTimer: ReturnType<typeof setInterval> | null = null;

  function startPaneScan() {
    paneScanTimer = setInterval(() => {
      if (clientCount === 0) return;
      refreshPaneAgents();
    }, PANE_SCAN_INTERVAL_MS);
  }

  function handleCommand(cmd: ClientCommand, ws: any) {
    switch (cmd.type) {
      case "switch-session": {
        // Switch the client(s) attached to the session whose sidebar sent the
        // command, resolved at switch time. A stored tty goes stale the moment
        // that client moves to another session — with two terminals attached it
        // routes the switch to the wrong terminal.
        const fromSession = clientSessionNames.get(ws);
        log("switch-session", "switching", { target: cmd.name, fromSession });
        const p = sessionProviders.get(cmd.name) ?? mux;

        p.switchSession(cmd.name, { fromSession });

        // Optimistic — clear unseen flags and tell TUIs in the target session
        // a client is arriving, without waiting for the tmux hook round-trip.
        // The hook's /focus POST will reconcile if needed. Carry the selection
        // so the destination sidebar highlights the clicked card.
        const hadUnseen = tracker.handleFocus(cmd.name);
        if (hadUnseen) broadcastState();
        publishSessionViewed(cmd.name, { session: cmd.name });

        break;
      }
      case "switch-index": {
        const fromSession = clientSessionNames.get(ws);
        switchToVisibleIndex(cmd.index, { fromSession });
        break;
      }
      case "new-session":
        mux.createSession(cmd.name, cmd.dir);
        if (cmd.launch === "claude" && cmd.name) mux.sendKeys(cmd.name, "claude");
        broadcastState();
        break;
      case "kill-session": {
        const p = sessionProviders.get(cmd.name) ?? mux;
        p.killSession(cmd.name);
        broadcastState();
        break;
      }
      case "reorder-session":
        sessionOrder.reorder(cmd.name, cmd.delta);
        broadcastState();
        break;
      case "refresh":
        broadcastState();
        break;
      case "mark-seen":
        if (tracker.markSeen(cmd.name)) broadcastState();
        break;
      case "dismiss-agent":
        if (tracker.dismiss(cmd.session, cmd.agent, cmd.threadId)) broadcastState();
        break;
      case "set-theme":
        currentTheme = cmd.theme;
        saveConfig({ theme: cmd.theme });
        broadcastState();
        break;
      case "report-width":
        // No-op: sidebar width is config-only, not auto-saved from drag
        break;
      case "quit":
        quitAll();
        break;
      case "identify-pane":
        // Store this client's session so switches can be routed to the
        // client(s) actually attached to it
        clientSessionNames.set(ws, cmd.sessionName);
        break;
      case "focus-agent-pane": {
        log("handleCommand", "focus-agent-pane received", {
          session: cmd.session,
          agent: cmd.agent,
          threadId: cmd.threadId,
          threadName: cmd.threadName,
        });
        const switched = focusAgentPane(
          cmd.session,
          cmd.agent,
          cmd.threadId,
          cmd.threadName,
          clientSessionNames.get(ws),
        );
        // The viewer just landed on the agent session's sidebar — hand the
        // clicked-agent selection over so that sidebar highlights it.
        if (switched) {
          publishSessionViewed(cmd.session, {
            session: cmd.session,
            agent: { agent: cmd.agent, threadId: cmd.threadId },
          });
        }
        break;
      }
      case "kill-agent-pane":
        log("handleCommand", "kill-agent-pane received", {
          session: cmd.session,
          agent: cmd.agent,
          threadId: cmd.threadId,
          threadName: cmd.threadName,
        });
        killAgentPane(cmd.session, cmd.agent, cmd.threadId, cmd.threadName);
        break;
    }
  }

  // --- Port polling (detect new/stopped listeners every 10s) ---

  let portPollTimer: ReturnType<typeof setInterval> | null = null;
  let gitPollTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    for (const w of allWatchers) w.stop();
    if (watcherBroadcastTimer) clearTimeout(watcherBroadcastTimer);
    teardownGitWatchers();
    if (portPollTimer) clearInterval(portPollTimer);
    if (gitPollTimer) clearInterval(gitPollTimer);
    if (paneScanTimer) clearInterval(paneScanTimer);
    if (pendingSidebarResize) clearTimeout(pendingSidebarResize);
    for (const timer of pendingHighlightResets.values()) clearTimeout(timer);
    pendingHighlightResets.clear();
    if (idleTimer) clearTimeout(idleTimer);
    try {
      unlinkSync(PID_FILE);
    } catch {
      // intentionally ignored: PID file may already be gone during shutdown
    }
    for (const p of allProviders) p.cleanupHooks();
  }

  // --- Write PID + start server ---

  writeFileSync(PID_FILE, String(process.pid));

  const server = Bun.serve({
    port: SERVER_PORT,
    hostname: SERVER_HOST,
    async fetch(req, server) {
      const url = new URL(req.url);

      // Any HTTP request proves tmux hooks are still active — reset idle timer
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }

      if (req.method === "POST" && url.pathname === "/refresh") {
        broadcastState();
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/resize-sidebars") {
        const body = await req.text();
        const ctx = parseResizeContext(body) ?? undefined;
        log("http", "POST /resize-sidebars", { sidebarWidth, ctx });
        scheduleSidebarResize(ctx);
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/focus") {
        try {
          const body = await req.text();
          const ctx = parseContext(body);
          if (ctx) {
            handleFocus(ctx.session);
          } else {
            // Legacy: body is just the session name
            const name = body.trim().replace(/^"+|"+$/g, "");
            if (name) handleFocus(name);
          }
        } catch {
          // intentionally ignored: malformed focus body is non-fatal, respond ok
        }
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/toggle") {
        try {
          const body = await req.text();
          const ctx = parseContext(body) ?? undefined;
          log("http", "POST /toggle", { ctx });
          toggleSidebar(ctx);
          broadcastState();
        } catch {
          // intentionally ignored: malformed toggle body is non-fatal, respond ok
        }
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/quit") {
        log("http", "POST /quit");
        quitAll();
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        log("http", "POST /shutdown");
        // Defer exit so this response flushes first; lets `tt agentboard
        // restart` terminate a server whose PID file was lost/rotated.
        setTimeout(() => {
          cleanup();
          process.exit(0);
        }, 50);
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/switch-index") {
        try {
          const index = Number.parseInt(url.searchParams.get("index") ?? "", 10);
          if (Number.isNaN(index)) {
            return new Response("missing index", { status: 400 });
          }
          const body = await req.text();
          const ctx = parseContext(body) ?? undefined;
          log("http", "POST /switch-index", { index, ctx });
          // ctx.clientTty comes from tmux expanding #{client_tty} at keypress
          // time — fresh, so targeting that exact client is correct here.
          switchToVisibleIndex(index, { clientTty: ctx?.clientTty });
        } catch {
          // intentionally ignored: malformed switch-index body is non-fatal, respond ok
        }
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/ensure-sidebar") {
        try {
          const body = await req.text();
          const ctx = parseContext(body) ?? undefined;
          log("http", "POST /ensure-sidebar", { sidebarVisible, ctx });
          // Debounce ensure-sidebar during rapid switching — intermediate sessions
          // don't need full sidebar validation immediately.
          debouncedEnsureSidebar(ctx ?? undefined);
        } catch {
          // intentionally ignored: malformed ensure-sidebar body is non-fatal, respond ok
        }
        return new Response("ok", { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/set-status") {
        try {
          const body = (await req.json()) as {
            session?: string;
            text?: string | null;
            tone?: string;
          };
          if (!body.session || typeof body.session !== "string") {
            return new Response("missing session", { status: 400 });
          }
          if (body.text === null || body.text === undefined) {
            metadataStore.setStatus(body.session, null);
          } else if (typeof body.text !== "string") {
            return new Response("text must be a string or null", { status: 400 });
          } else {
            metadataStore.setStatus(body.session, { text: body.text, tone: parseTone(body.tone) });
          }
          broadcastState();
          return new Response(null, { status: 204 });
        } catch {
          return new Response("invalid json", { status: 400 });
        }
      }

      if (req.method === "POST" && url.pathname === "/set-progress") {
        try {
          const body = (await req.json()) as {
            session?: string;
            current?: number;
            total?: number;
            percent?: number;
            label?: string;
            clear?: boolean;
          };
          if (!body.session || typeof body.session !== "string") {
            return new Response("missing session", { status: 400 });
          }
          if (body.clear) {
            metadataStore.setProgress(body.session, null);
          } else {
            metadataStore.setProgress(body.session, {
              current: body.current,
              total: body.total,
              percent: body.percent,
              label: body.label,
            });
          }
          broadcastState();
          return new Response(null, { status: 204 });
        } catch {
          return new Response("invalid json", { status: 400 });
        }
      }

      if (req.method === "POST" && url.pathname === "/log") {
        try {
          const body = (await req.json()) as {
            session?: string;
            message?: string;
            tone?: string;
            source?: string;
          };
          if (!body.session || typeof body.session !== "string") {
            return new Response("missing session", { status: 400 });
          }
          if (!body.message || typeof body.message !== "string") {
            return new Response("missing message", { status: 400 });
          }
          metadataStore.appendLog(body.session, {
            message: body.message,
            tone: parseTone(body.tone),
            source: body.source,
          });
          broadcastState();
          return new Response(null, { status: 204 });
        } catch {
          return new Response("invalid json", { status: 400 });
        }
      }

      if (req.method === "POST" && url.pathname === "/clear-log") {
        try {
          const body = (await req.json()) as { session?: string };
          if (!body.session || typeof body.session !== "string") {
            return new Response("missing session", { status: 400 });
          }
          metadataStore.clearLogs(body.session);
          broadcastState();
          return new Response(null, { status: 204 });
        } catch {
          return new Response("invalid json", { status: 400 });
        }
      }

      if (server.upgrade(req)) return;
      return Response.json({
        name: "agentboard server",
        routes: [
          "POST /refresh",
          "POST /resize-sidebars",
          "POST /focus",
          "POST /toggle",
          "POST /quit",
          "POST /switch-index?index=N",
          "POST /ensure-sidebar",
          "POST /set-status",
          "POST /set-progress",
          "POST /log",
          "POST /clear-log",
          "WS   /",
        ],
      });
    },
    websocket: {
      open(ws) {
        ws.subscribe("sidebar");
        clientCount++;
        log("ws", "client connected", { clientCount });
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (lastState) {
          ws.send(JSON.stringify(lastState));
        } else {
          broadcastState();
        }
      },
      close(ws) {
        ws.unsubscribe("sidebar");
        clientCount--;
        if (clientCount < 0) clientCount = 0;
        log("ws", "client disconnected", { clientCount });
        if (clientCount === 0 && !idleTimer) {
          log("ws", "no clients remaining, starting idle timer", {
            timeoutMs: SERVER_IDLE_TIMEOUT_MS,
          });
          idleTimer = setTimeout(() => {
            log("ws", "idle timeout reached, shutting down");
            quitAll();
          }, SERVER_IDLE_TIMEOUT_MS);
        }
      },
      message(ws, msg) {
        try {
          const cmd = JSON.parse(msg as string) as ClientCommand;
          log("ws", "command", { type: cmd.type });
          handleCommand(cmd, ws);
        } catch {
          // intentionally ignored: malformed websocket command is non-fatal
        }
      },
    },
  });

  // --- Bootstrap ---

  for (const p of allProviders) p.setupHooks(SERVER_HOST, SERVER_PORT);
  // Seed port snapshot before first broadcast so clients see ports immediately
  {
    const allMuxSessions: string[] = [];
    for (const p of allProviders) {
      for (const s of p.listSessions()) allMuxSessions.push(s.name);
    }
    refreshPortSnapshot(allMuxSessions);
  }
  broadcastState();
  portPollTimer = startPortPoll({
    getSessions: () => lastState?.sessions ?? null,
    getClientCount: () => clientCount,
    broadcastState,
  });
  gitPollTimer = startGitPoll({
    getSessions: () => (lastState ? [...lastState.sessions, ...lastState.slots] : null),
    getClientCount: () => clientCount,
    broadcastState,
  });
  startPaneScan();
  // Run initial pane scan
  refreshPaneAgents();

  // Start agent watchers after server is ready
  for (const w of allWatchers) {
    w.start(watcherCtx);
    log("server", `agent watcher started: ${w.name}`);
  }

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  const names = allProviders.map((p) => p.name).join(", ");
  consola.info(`agentboard server listening on ${SERVER_HOST}:${SERVER_PORT} (mux: ${names})`);
}
