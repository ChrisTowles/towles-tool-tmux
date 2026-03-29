export const COLUMNS = [
  "ready",
  "in_progress",
  "simplify_review",
  "review",
  "done",
  "archived",
] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  ready: "Ready",
  in_progress: "In Progress",
  simplify_review: "Simplify + Review",
  review: "Review",
  done: "Done",
  archived: "Archived",
};

export const COLUMN_ICONS: Record<Column, string> = {
  ready: "◆",
  in_progress: "▶",
  simplify_review: "⟳",
  review: "◉",
  done: "✓",
  archived: "▪",
};

export type CardStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_input"
  | "review_ready"
  | "done"
  | "failed"
  | "blocked";

export const STATUS_BORDER_CLASSES: Record<CardStatus, string> = {
  failed: "border-red-500 shadow-red-500/20",
  waiting_input: "border-amber-400 shadow-amber-400/20",
  running: "border-blue-500 shadow-blue-500/20",
  done: "border-emerald-500 shadow-emerald-500/20",
  review_ready: "border-emerald-500 shadow-emerald-500/20",
  idle: "border-zinc-700",
  queued: "border-zinc-600",
  blocked: "border-zinc-700",
};

export const STATUS_LABELS: Record<CardStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  waiting_input: "Waiting",
  review_ready: "Review Ready",
  done: "Done",
  failed: "Failed",
  blocked: "Blocked",
};

export const STATUS_DESCRIPTIONS: Record<CardStatus, string> = {
  idle: "Card is waiting in the backlog",
  queued: "No workspace slot available — will start when one opens up",
  running: "Agent is actively working on this card",
  waiting_input: "Agent is paused and needs your input",
  review_ready: "Agent finished — ready for your review",
  done: "Card is complete and archived",
  failed: "Agent encountered an error",
  blocked: "Blocked by a dependency",
};

export const EXECUTION_MODE_LABELS: Record<string, string> = {
  "auto-claude": "Auto-Claude",
  claude: "Claude",
};

export const PR_GRANULARITY_LABELS: Record<string, string> = {
  per_card: "Per Card",
  per_plan: "Per Plan",
};

export const STATUS_DOT_CLASSES: Record<CardStatus, string> = {
  failed: "bg-red-500",
  waiting_input: "bg-amber-400",
  running: "bg-blue-500",
  done: "bg-emerald-500",
  review_ready: "bg-emerald-500",
  idle: "bg-zinc-500",
  queued: "bg-zinc-400",
  blocked: "bg-zinc-600",
};
