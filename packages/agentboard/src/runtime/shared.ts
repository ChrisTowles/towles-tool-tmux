import type { AgentStatus, AgentEvent } from "./contracts/agent";
import type { ReorderDelta } from "./server/session-order";

export type { ReorderDelta };

export const DEFAULT_SERVER_PORT = 4201;
export const DEFAULT_SERVER_HOST = "127.0.0.1";

export const SERVER_PORT: number = Number(process.env.TT_AGENTBOARD_PORT) || DEFAULT_SERVER_PORT;
export const SERVER_HOST: string = process.env.TT_AGENTBOARD_HOST || DEFAULT_SERVER_HOST;
export const PID_FILE = "/tmp/agentboard.pid";
export const SERVER_IDLE_TIMEOUT_MS = 30_000;
export const STUCK_RUNNING_TIMEOUT_MS = 3 * 60 * 1000;
export const STALE_AGENT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
// An agent only goes "idle" once its process is gone / journal stalled, so an
// unpinned idle instance is a dead session (e.g. a Claude session after /clear).
// Prune it shortly after, leaving a brief grace for the pane scan to (re)pin live ones.
export const IDLE_PRUNE_MS = 30_000;
export const JOURNAL_IDLE_TIMEOUT_MS = 120_000;

export interface SessionData {
  name: string;
  createdAt: number;
  dir: string;
  branch: string;
  isWorktree: boolean;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commitsDelta: number;
  unseen: boolean;
  panes: number;
  ports: number[];
  windows: number;
  uptime: string;
  agentState: AgentEvent | null;
  agents: AgentEvent[];
  eventTimestamps: number[];
  metadata?: SessionMetadata | null;
}

/** A configured repo slot with no live tmux session — git info only, no session state. */
export interface SlotInfo {
  dir: string;
  name: string;
  branch: string;
  isWorktree: boolean;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commitsDelta: number;
}

export interface ServerState {
  type: "state";
  sessions: SessionData[];
  slots: SlotInfo[];
  theme: string | undefined;
  sidebarWidth: number;
  preferredEditor: string;
  ts: number;
}

/**
 * A client (terminal) is now viewing this session — fired by the tmux focus
 * hook and optimistically on sidebar-initiated switches. TUIs in the named
 * session reset their local pending-switch marker. Card selection stays
 * per-TUI; `select` is the one exception: when a sidebar action caused the
 * switch, the destination sidebar adopts this selection so the clicked
 * card/agent is highlighted after the viewer lands on it.
 */
export interface SessionViewed {
  type: "session-viewed";
  name: string;
  select?: {
    session: string;
    agent?: { agent: string; threadId?: string };
  };
}

export interface ResizeNotify {
  type: "resize";
  width: number;
}

export interface QuitNotify {
  type: "quit";
}

export interface ReIdentify {
  type: "re-identify";
}

export type ServerMessage = ServerState | SessionViewed | ResizeNotify | QuitNotify | ReIdentify;

// --- Programmatic metadata (agent/script-pushed) ---

export type MetadataTone = "neutral" | "info" | "success" | "warn" | "error";

export interface MetadataStatus {
  text: string;
  tone?: MetadataTone;
  ts: number;
}

export interface MetadataProgress {
  current?: number;
  total?: number;
  percent?: number;
  label?: string;
  ts: number;
}

export interface MetadataLogEntry {
  message: string;
  tone?: MetadataTone;
  source?: string;
  ts: number;
}

export interface SessionMetadata {
  status: MetadataStatus | null;
  progress: MetadataProgress | null;
  logs: MetadataLogEntry[];
}

export type ClientCommand =
  | { type: "switch-session"; name: string }
  | { type: "switch-index"; index: number }
  | { type: "new-session"; dir?: string; name?: string; launch?: "claude" }
  | { type: "kill-session"; name: string }
  | { type: "reorder-session"; name: string; delta: ReorderDelta }
  | { type: "refresh" }
  | { type: "mark-seen"; name: string }
  | { type: "dismiss-agent"; session: string; agent: string; threadId?: string }
  | { type: "set-theme"; theme: string }
  | { type: "report-width"; width: number }
  | { type: "quit" }
  | { type: "identify-pane"; paneId: string; sessionName: string }
  | {
      type: "focus-agent-pane";
      session: string;
      agent: string;
      threadId?: string;
      threadName?: string;
    }
  | {
      type: "kill-agent-pane";
      session: string;
      agent: string;
      threadId?: string;
      threadName?: string;
    };

// Catppuccin Mocha palette
export const C = {
  blue: "#89b4fa",
  lavender: "#b4befe",
  pink: "#cba6f7",
  mauve: "#cba6f7",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  red: "#f38ba8",
  peach: "#fab387",
  teal: "#94e2d5",
  sky: "#89dceb",
  text: "#cdd6f4",
  subtext0: "#a6adc8",
  subtext1: "#bac2de",
  overlay0: "#6c7086",
  overlay1: "#7f849c",
  surface0: "#313244",
  surface1: "#45475a",
  surface2: "#585b70",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
} as const;

export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: C.surface2,
  running: C.yellow,
  done: C.green,
  error: C.red,
  waiting: C.blue,
  question: C.sky,
  interrupted: C.peach,
};

export const STATUS_ICONS: Record<AgentStatus, string> = {
  idle: "○",
  running: "●",
  done: "✓",
  error: "✗",
  waiting: "◉",
  question: "?",
  interrupted: "⚠",
};
