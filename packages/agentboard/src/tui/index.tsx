import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { appendFileSync } from "node:fs";
import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  batch,
  For,
  Show,
  createMemo,
  createSelector,
} from "solid-js";
import type { Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import { ensureServer, SERVER_PORT, SERVER_HOST, resolveTheme } from "../runtime/index";
import type {
  ServerMessage,
  SessionData,
  ClientCommand,
  ReorderDelta,
  Theme,
} from "../runtime/index";
import { SessionCard } from "./components/SessionCard";
import { StatusBar } from "./components/StatusBar";
import { detectMuxContext, refocusMainPane, getLocalSessionName } from "./mux-context";
import { SPINNERS, BOLD, DIM, DIVIDER, logResizeDebug } from "./constants";

const muxCtx = detectMuxContext();

const TUI_DEBUG = !!process.env.TT_AGENTBOARD_DEBUG;

function KeyHints(props: {
  hints: [string, string][];
  palette: Accessor<Theme["palette"]>;
  cols?: number;
}) {
  const cols = () => props.cols ?? 2;
  const rows = () => {
    const pairs: [string, string][][] = [];
    for (let i = 0; i < props.hints.length; i += cols()) {
      pairs.push(props.hints.slice(i, i + cols()));
    }
    return pairs;
  };

  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row">
            <For each={row}>
              {([key, label]) => (
                <box width={16} flexShrink={0}>
                  <text>
                    <span style={{ fg: props.palette().overlay0 }}>{key}</span>
                    <span style={{ fg: props.palette().overlay1 }}>{` ${label}`}</span>
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

function App() {
  const renderer = useRenderer();

  // --- Theme state (driven by server) ---
  const [theme, setTheme] = createSignal<Theme>(resolveTheme(undefined));
  const P = () => theme().palette;
  const S = () => theme().status;

  const [sessions, setSessions] = createStore<SessionData[]>([]);
  const [focusedSession, setFocusedSession] = createSignal<string | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [spinIdx, setSpinIdx] = createSignal(0);
  const [preferredEditor, setPreferredEditor] = createSignal("code");

  // --- Panel focus: sessions list vs agent detail ---
  type PanelFocus = "sessions" | "agents";
  const [panelFocus, setPanelFocus] = createSignal<PanelFocus>("sessions");
  const [focusedAgentIdx, setFocusedAgentIdx] = createSignal(0);

  // --- Modal state ---
  const [modal, setModal] = createSignal<"none" | "confirm-kill" | "help">("none");
  const [killTarget, setKillTarget] = createSignal<string | null>(null);

  // --- Transient toast (footer) ---
  type ToastTone = "error" | "info" | "success";
  const [toast, setToast] = createSignal<{ message: string; tone: ToastTone } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(message: string, tone: ToastTone = "info") {
    setToast({ message, tone });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 4000);
  }

  let ws: WebSocket | null = null;
  const startupSessionName = getLocalSessionName(muxCtx);

  // --- Current session (the ● you-are-here marker) ---
  // This TUI lives in a pane inside `startupSessionName`; anyone seeing it is
  // attached to that session, so "current" is the local session — not a server
  // global. (The server can't know one true current session once multiple
  // clients are attached.) `pendingSwitch` optimistically marks the target of
  // a click/Tab until the view actually moves away; it resets when a focus
  // broadcast says this session is being viewed again.
  const [pendingSwitch, setPendingSwitch] = createSignal<string | null>(null);
  const currentSession = () => pendingSwitch() ?? startupSessionName;

  const focusedData = createMemo(() => sessions.find((s) => s.name === focusedSession()) ?? null);

  function send(cmd: ClientCommand, successMsg?: string): boolean {
    if (connected() && ws) {
      ws.send(JSON.stringify(cmd));
      if (successMsg) showToast(successMsg, "success");
      return true;
    }
    showToast("not connected to agentboard server", "error");
    return false;
  }

  function switchToSession(name: string) {
    // Optimistic local update — makes rapid Tab repeat instant by removing
    // the server/hook round-trip from the next-Tab decision.
    // The server's focus/state broadcast will reconcile if needed.
    setPendingSwitch(name);
    setFocusedSession(name);
    setPanelFocus("sessions");
    setFocusedAgentIdx(0);
    send({ type: "switch-session", name });
  }

  function reIdentify() {
    const sessionName = getLocalSessionName(muxCtx);
    if (!sessionName) return;

    if (muxCtx.type === "tmux") {
      send({ type: "identify-pane", paneId: muxCtx.paneId, sessionName });
    }
  }

  function moveLocalFocus(delta: -1 | 1) {
    const list = sessions;
    if (list.length === 0) return;

    const current = focusedSession();
    const currentIdx = Math.max(
      0,
      list.findIndex((s) => s.name === current),
    );
    const nextIdx = Math.max(0, Math.min(list.length - 1, currentIdx + delta));
    const next = list[nextIdx]?.name ?? null;

    if (!next || next === current) return;

    // Selection is local to this TUI — never sent to the server. Broadcasting
    // it would move the selection in every other sidebar too.
    setFocusedSession(next);
  }

  function moveAgentFocus(delta: -1 | 1) {
    const data = focusedData();
    const agents = data?.agents ?? [];
    if (agents.length === 0) return;
    const idx = focusedAgentIdx();
    const next = Math.max(0, Math.min(agents.length - 1, idx + delta));
    setFocusedAgentIdx(next);
  }

  function activateFocusedAgent() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    // Focusing the agent's pane switches this terminal to its session.
    setPendingSwitch(data.name);
    if (TUI_DEBUG)
      appendFileSync(
        "/tmp/agentboard-tui-agent-click.log",
        `[${new Date().toISOString()}] keyboard focus-agent-pane session=${data.name} agent=${agent.agent} threadId=${agent.threadId} threadName=${agent.threadName}\n`,
      );
    send(
      {
        type: "focus-agent-pane",
        session: data.name,
        agent: agent.agent,
        threadId: agent.threadId,
        threadName: agent.threadName,
      },
      `focusing ${agent.agent}`,
    );
  }

  function dismissFocusedAgent() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    send(
      { type: "dismiss-agent", session: data.name, agent: agent.agent, threadId: agent.threadId },
      `dismissed ${agent.agent}`,
    );
    if (focusedAgentIdx() >= agents.length - 1 && agents.length > 1) {
      setFocusedAgentIdx(agents.length - 2);
    }
    if (agents.length <= 1) setPanelFocus("sessions");
  }

  function killFocusedAgentPane() {
    const data = focusedData();
    const agents = data?.agents ?? [];
    const agent = agents[focusedAgentIdx()];
    if (!agent || !data) return;
    send(
      {
        type: "kill-agent-pane",
        session: data.name,
        agent: agent.agent,
        threadId: agent.threadId,
        threadName: agent.threadName,
      },
      `killed ${agent.agent} pane`,
    );
  }

  function createNewSession() {
    if (muxCtx.type !== "tmux") {
      send({ type: "new-session" });
      return;
    }
    const scriptPath = new URL("./scripts/sessionizer.sh", import.meta.url).pathname;
    muxCtx.sdk.displayPopup({
      command: `bash "${scriptPath}"`,
      title: " new session ",
      width: "60%",
      height: "60%",
      closeOnExit: true,
    });
  }

  function openInEditor() {
    const data = focusedData();
    if (!data?.dir) return;
    const editor = preferredEditor();
    try {
      // Strip tmux env vars so the editor (and any terminal it opens) isn't
      // locked into our outer tmux session.
      const cleanEnv = { ...process.env };
      delete cleanEnv.TMUX;
      delete cleanEnv.TMUX_PANE;
      delete cleanEnv.TMUX_PLUGIN_MANAGER_PATH;
      const proc = Bun.spawn([editor, data.dir], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: cleanEnv,
      });
      showToast(`opening ${data.dir} in ${editor}`, "success");
      void proc.exited.then((code) => {
        if (code !== 0) {
          logResizeDebug("openInEditor failed", { editor, dir: data.dir, code });
          showToast(`failed to open editor "${editor}" (exit ${code})`, "error");
        }
      });
    } catch (err) {
      logResizeDebug("openInEditor spawn threw", {
        editor,
        dir: data.dir,
        error: String(err),
      });
      showToast(`failed to spawn editor "${editor}": ${String(err)}`, "error");
    }
  }

  onMount(() => {
    if (TUI_DEBUG)
      logResizeDebug("mount", {
        startupSessionName,
        localSessionName: getLocalSessionName(muxCtx),
        muxType: muxCtx.type,
        tmuxPane: process.env.TMUX_PANE ?? null,
      });
    // Refocus the main pane once terminal capability detection finishes.
    // This avoids the race where the server refocuses too early and capability
    // responses leak as garbage text into the main pane.
    let startupRefocused = false;
    const doStartupRefocus = () => {
      if (startupRefocused) return;
      startupRefocused = true;
      refocusMainPane(muxCtx);
    };
    renderer.on("capabilities", doStartupRefocus);
    // Fallback: if no capability response arrives within 2s, refocus anyway
    const refocusTimeout = setTimeout(doStartupRefocus, 2000);

    onCleanup(() => {
      if (toastTimer) clearTimeout(toastTimer);
      clearTimeout(refocusTimeout);
      renderer.removeListener("capabilities", doStartupRefocus);
    });

    const socket = new WebSocket(`ws://${SERVER_HOST}:${SERVER_PORT}`);
    ws = socket;

    socket.onopen = () => {
      setConnected(true);
      reIdentify();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        batch(() => {
          if (msg.type === "state") {
            setSessions(reconcile(msg.sessions, { key: "name" }));
            // Selection is local — initialize to this sidebar's own session,
            // and repair it if the selected session disappeared.
            const selected = focusedSession();
            if (!selected || !msg.sessions.some((s) => s.name === selected)) {
              setFocusedSession(
                msg.sessions.find((s) => s.name === startupSessionName)?.name ??
                  msg.sessions[0]?.name ??
                  null,
              );
            }
            // Drop the optimistic switch marker if its target no longer exists.
            const pending = pendingSwitch();
            if (pending && !msg.sessions.some((s) => s.name === pending)) {
              setPendingSwitch(null);
            }
            setTheme(resolveTheme(msg.theme));
            if (msg.preferredEditor) setPreferredEditor(msg.preferredEditor);
          } else if (msg.type === "session-viewed") {
            if (msg.name === startupSessionName) {
              // A client is viewing this session again — any optimistic
              // switch-away marker is stale.
              setPendingSwitch(null);
              // Selection handoff: a sidebar action moved the viewer here.
              // Adopt the selection so the card/agent clicked in the
              // originating sidebar is the one highlighted in this sidebar.
              const sel = msg.select;
              if (sel && sessions.some((s) => s.name === sel.session)) {
                setFocusedSession(sel.session);
                const agentSel = sel.agent;
                if (agentSel) {
                  const data = sessions.find((s) => s.name === sel.session);
                  const idx = (data?.agents ?? []).findIndex(
                    (a) => a.agent === agentSel.agent && a.threadId === agentSel.threadId,
                  );
                  if (idx >= 0) {
                    setPanelFocus("agents");
                    setFocusedAgentIdx(idx);
                  }
                } else {
                  setPanelFocus("sessions");
                }
              }
            }
          } else if (msg.type === "re-identify") {
            reIdentify();
          } else if (msg.type === "quit") {
            if (ws) ws.close();
            renderer.destroy();
          }
        });
      } catch {
        // intentionally ignored: socket setup errors are non-fatal at startup
      }
    };

    socket.onclose = () => {
      setConnected(false);
      renderer.destroy();
    };

    onCleanup(() => socket.close());
  });

  const hasRunning = createMemo(() => sessions.some((s) => s.agentState?.status === "running"));

  createEffect(() => {
    if (!hasRunning()) return;
    const interval = setInterval(() => {
      setSpinIdx((i) => (i + 1) % SPINNERS.length);
    }, 120);
    onCleanup(() => clearInterval(interval));
  });

  // Shared 1s clock for elapsed-time displays.
  // Ticks only while any agent is running.
  const [now, setNow] = createSignal(Date.now());
  const needsTicker = createMemo(() =>
    sessions.some((s) => s.agents?.some((a) => a.status === "running")),
  );
  createEffect(() => {
    if (!needsTicker()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(id));
  });

  useKeyboard((key) => {
    const currentModal = modal();

    // --- Help modal ---
    if (currentModal === "help") {
      setModal("none");
      return;
    }

    // --- Confirm kill modal ---
    if (currentModal === "confirm-kill") {
      if (key.name === "y") {
        const target = killTarget();
        if (target) send({ type: "kill-session", name: target }, `killed ${target}`);
        setKillTarget(null);
        setModal("none");
      } else {
        setKillTarget(null);
        setModal("none");
      }
      return;
    }

    // --- Normal mode keybindings ---
    // Help: "?" arrives as {name: "/", shift: true} under Kitty keyboard protocol,
    // or as {name: "?"} in raw mode. Match both.
    if (key.name === "?" || (key.name === "/" && key.shift)) {
      setModal("help");
      return;
    }

    // Alt+Up/Down → reorder session ±1. Alt+Shift+Up/Down → jump to top/bottom.
    if ((key.meta || key.option) && (key.name === "up" || key.name === "down")) {
      const focused = focusedSession();
      if (focused) {
        const up = key.name === "up";
        const delta: ReorderDelta = key.shift ? (up ? "top" : "bottom") : up ? "up" : "down";
        send({ type: "reorder-session", name: focused, delta });
      }
      return;
    }

    switch (key.name) {
      case "q":
        send({ type: "quit" });
        break;
      case "escape":
        if (panelFocus() === "agents") {
          setPanelFocus("sessions");
        }
        break;
      case "up":
      case "k":
        if (panelFocus() === "agents") {
          moveAgentFocus(-1);
        } else {
          moveLocalFocus(-1);
        }
        break;
      case "down":
      case "j":
        if (panelFocus() === "agents") {
          moveAgentFocus(1);
        } else {
          moveLocalFocus(1);
        }
        break;
      case "left":
      case "h":
        if (panelFocus() === "agents") {
          setPanelFocus("sessions");
        }
        break;
      case "right":
      case "l": {
        const data = focusedData();
        const agents = data?.agents ?? [];
        if (panelFocus() === "sessions" && agents.length > 0) {
          setPanelFocus("agents");
          setFocusedAgentIdx((idx) => Math.min(idx, agents.length - 1));
        }
        break;
      }
      case "return": {
        if (panelFocus() === "agents") {
          activateFocusedAgent();
        } else {
          const focused = focusedSession();
          if (focused) switchToSession(focused);
        }
        break;
      }
      case "tab": {
        const list = sessions;
        if (list.length === 0) break;
        const cur = currentSession();
        const idx = list.findIndex((s) => s.name === cur);
        const next = list[(idx + (key.shift ? list.length - 1 : 1)) % list.length];
        if (next) switchToSession(next.name);
        break;
      }
      case "r":
        send({ type: "refresh" }, "refreshing sessions");
        break;
      case "d":
        if (panelFocus() === "agents") dismissFocusedAgent();
        break;
      case "x": {
        if (panelFocus() === "agents") {
          killFocusedAgentPane();
        } else {
          const focused = focusedSession();
          if (focused) {
            setKillTarget(focused);
            setModal("confirm-kill");
          }
        }
        break;
      }
      case "e":
        openInEditor();
        break;
      case "n":
        createNewSession();
        break;
      default: {
        if (key.number) {
          const idx = Number.parseInt(key.name, 10) - 1;
          const target = sessions[idx];
          if (target) switchToSession(target.name);
        }
        break;
      }
    }
  });

  const runningAgentCount = createMemo(() =>
    sessions.reduce((n, s) => n + (s.agents?.filter((a) => a.status === "running").length ?? 0), 0),
  );

  const errorAgentCount = createMemo(() =>
    sessions.reduce((n, s) => n + (s.agents?.filter((a) => a.status === "error").length ?? 0), 0),
  );

  const unseenCount = createMemo(() => sessions.filter((s) => s.unseen).length);

  const isFocused = createSelector(focusedSession);

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={P().crust}>
      {/* Header */}
      <StatusBar
        sessionCount={sessions.length}
        runningCount={runningAgentCount()}
        errorCount={errorAgentCount()}
        unseenCount={unseenCount()}
        theme={theme}
      />

      {/* Session list */}
      <scrollbox flexGrow={1} flexShrink={1} paddingTop={0}>
        <box height={1}>
          <text style={{ fg: P().overlay0 }}>{DIVIDER}</text>
        </box>
        <For each={sessions}>
          {(session, i) => (
            <box flexDirection="column" flexShrink={0}>
              <Show when={i() > 0}>
                <box height={1}>
                  <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
                </box>
              </Show>
              <SessionCard
                session={session}
                isFocused={isFocused(session.name)}
                isCurrent={session.name === currentSession()}
                spinIdx={spinIdx}
                now={now}
                theme={theme}
                statusColors={S}
                focusedAgentIdx={
                  isFocused(session.name) && panelFocus() === "agents" ? focusedAgentIdx() : -1
                }
                onSelect={() => {
                  setFocusedSession(session.name);
                  switchToSession(session.name);
                }}
                onDismissAgent={(agent) => {
                  send({
                    type: "dismiss-agent",
                    session: session.name,
                    agent: agent.agent,
                    threadId: agent.threadId,
                  });
                }}
                onFocusAgentPane={(agent, idx) => {
                  // The click switches this terminal to the agent's session —
                  // move the local selection, agent-row highlight, and current
                  // marker with it. (The row's onMouseDown stops propagation,
                  // so the card's onSelect doesn't run for agent-row clicks.)
                  setFocusedSession(session.name);
                  setPanelFocus("agents");
                  setFocusedAgentIdx(idx);
                  setPendingSwitch(session.name);
                  send({
                    type: "focus-agent-pane",
                    session: session.name,
                    agent: agent.agent,
                    threadId: agent.threadId,
                    threadName: agent.threadName,
                  });
                }}
              />
            </box>
          )}
        </For>
      </scrollbox>

      {/* Footer */}
      <box flexDirection="column" paddingLeft={1} paddingBottom={1} paddingTop={0} flexShrink={0}>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
        </box>
        <Show when={toast()}>
          {(t: Accessor<NonNullable<ReturnType<typeof toast>>>) => (
            <box height={1}>
              <text
                style={{
                  fg:
                    t().tone === "error" ? P().red : t().tone === "success" ? P().green : P().blue,
                }}
              >
                {t().message}
              </text>
            </box>
          )}
        </Show>
        <Show
          when={panelFocus() === "sessions"}
          fallback={
            <KeyHints
              palette={P}
              hints={[
                ["←", "back"],
                ["⏎", "focus"],
                ["d", "dismiss"],
                ["x", "kill"],
              ]}
            />
          }
        >
          <box height={1}>
            <text>
              <span style={{ fg: P().overlay0 }}>?</span>
              <span style={{ fg: P().overlay1 }}> help</span>
            </text>
          </box>
        </Show>
      </box>

      {/* Kill confirmation overlay */}
      <Show when={modal() === "confirm-kill"}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          justifyContent="center"
          alignItems="center"
          backgroundColor="transparent"
        >
          <box
            border
            borderStyle="rounded"
            borderColor={P().red}
            backgroundColor={P().mantle}
            padding={1}
            paddingX={2}
            flexDirection="column"
            alignItems="center"
          >
            <text>
              <span style={{ fg: P().red, attributes: BOLD }}>Kill session?</span>
            </text>
            <text>
              <span style={{ fg: P().text }}>{killTarget() ?? ""}</span>
            </text>
            <text>
              <span style={{ fg: P().overlay0 }}>y</span>
              <span style={{ fg: P().overlay1 }}>/</span>
              <span style={{ fg: P().overlay0 }}>n</span>
            </text>
          </box>
        </box>
      </Show>

      {/* Help overlay */}
      <Show when={modal() === "help"}>
        <HelpOverlay palette={P} onClose={() => setModal("none")} />
      </Show>
    </box>
  );
}

// --- Help Overlay ---

const HELP_KEYS: [string, string][] = [
  ["j/k ↑↓", "Move focus"],
  ["Enter", "Switch to session"],
  ["1-9", "Jump to session"],
  ["Tab", "Cycle sessions"],
  ["n", "New session"],
  ["e", "Open in editor"],
  ["x", "Kill session"],
  ["r", "Refresh"],
  ["→/l", "Agents panel"],
  ["←/h/Esc", "Back to sessions"],
  ["Alt+↑↓", "Reorder sessions"],
  ["Alt+Shift+↑↓", "To top/bottom"],
  ["q", "Quit"],
];

function HelpOverlay(props: { palette: Accessor<Theme["palette"]>; onClose: () => void }) {
  const P = () => props.palette();
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      justifyContent="center"
      alignItems="center"
      backgroundColor="transparent"
    >
      <box
        border
        borderStyle="rounded"
        borderColor={P().blue}
        backgroundColor={P().mantle}
        padding={1}
        flexDirection="column"
        width={32}
      >
        <text>
          <span style={{ fg: P().blue, attributes: BOLD }}>Keybindings</span>
        </text>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
        </box>
        <box flexDirection="column">
          <For each={HELP_KEYS}>
            {([key, desc]) => (
              <box flexDirection="row">
                <box width={14} flexShrink={0}>
                  <text truncate>
                    <span style={{ fg: P().sky }}>{key}</span>
                  </text>
                </box>
                <text truncate>
                  <span style={{ fg: P().subtext0 }}>{desc}</span>
                </text>
              </box>
            )}
          </For>
        </box>
        <box height={1}>
          <text style={{ fg: P().surface2 }}>{DIVIDER}</text>
        </box>
        <text style={{ fg: P().overlay0 }}>
          <span style={{ attributes: DIM }}>Press any key to close</span>
        </text>
      </box>
    </box>
  );
}

async function main() {
  await ensureServer();
  render(() => <App />, {
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: true,
    // Undefined defaults to enabled with opentui's default flags — explicit
    // null opts out. The sidebar shares a tmux client with plain shell panes
    // that don't speak the kitty protocol's CSI-u key encoding, so leaving
    // it enabled here leaks garbled escape sequences (e.g. Esc) into them.
    useKittyKeyboard: null,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
