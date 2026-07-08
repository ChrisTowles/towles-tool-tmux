import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import consola from "consola";
import { startSessionPoll } from "./poll";

// --- Shell helpers (for git commands only) ---

export function shell(cmd: string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return result.stdout.toString().trim();
  } catch {
    return "";
  }
}

async function shellAsync(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out.trim();
  } catch {
    return "";
  }
}

// --- Git helpers ---

export interface GitInfo {
  branch: string;
  isWorktree: boolean;
  /**
   * filesChanged/linesAdded/linesRemoved measure the working tree against the
   * pushed baseline (merge-base with the branch's upstream, else origin/main):
   * uncommitted changes plus unpushed commits. commitsDelta deliberately uses
   * a different baseline — distance from origin/main — so the two can disagree
   * on a feature branch tracking its own remote.
   */
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Positive = ahead of origin/main, negative = behind */
  commitsDelta: number;
}

function emptyGitInfo(): GitInfo {
  return {
    branch: "",
    isWorktree: false,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commitsDelta: 0,
  };
}

const gitInfoCache = new Map<string, { info: GitInfo; ts: number }>();
// Must stay above the git poll interval so the poll keeps entries warm for
// the synchronous readers; freshness comes from the poll and explicit
// invalidation, not from a short TTL.
const GIT_CACHE_TTL_MS = 5000;

/**
 * Synchronous cache-only read. Serves stale entries rather than blocking the
 * event loop; a stale or missing entry kicks off a background refresh, and
 * the git poll broadcasts once fresh numbers land.
 */
export function getGitInfo(dir: string): GitInfo {
  if (!dir) return emptyGitInfo();
  const cached = gitInfoCache.get(dir);
  if (cached && Date.now() - cached.ts < GIT_CACHE_TTL_MS) return cached.info;
  void refreshGitInfo(dir);
  return cached?.info ?? emptyGitInfo();
}

/** Mark entries stale so the next read serves them while a refresh runs. */
export function invalidateGitCache(dir?: string): void {
  if (dir) {
    const cached = gitInfoCache.get(dir);
    if (cached) cached.ts = 0;
  } else {
    for (const cached of gitInfoCache.values()) cached.ts = 0;
  }
}

const gitRefreshInFlight = new Map<string, Promise<GitInfo>>();

/** Recompute git info via async spawns (no event-loop blocking) and cache it. */
function refreshGitInfo(dir: string): Promise<GitInfo> {
  const pending = gitRefreshInFlight.get(dir);
  if (pending) return pending;
  const refresh = computeGitInfo(dir)
    .catch(() => emptyGitInfo())
    .then((info) => {
      gitInfoCache.set(dir, { info, ts: Date.now() });
      return info;
    })
    .finally(() => {
      gitRefreshInFlight.delete(dir);
    });
  gitRefreshInFlight.set(dir, refresh);
  return refresh;
}

async function computeGitInfo(dir: string): Promise<GitInfo> {
  const branch = await shellAsync(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return emptyGitInfo();
  const [gitDir, statusOut, originMain] = await Promise.all([
    shellAsync(["git", "-C", dir, "rev-parse", "--git-dir"]),
    shellAsync(["git", "-C", dir, "status", "--porcelain"]),
    resolveOriginMain(dir),
  ]);

  // Diff stats vs. the pushed baseline: uncommitted changes + unpushed commits
  // (everything between what's on the remote and the current working tree).
  const base = await resolvePushedBase(dir, originMain);
  const [diffOut, aheadBehind] = await Promise.all([
    shellAsync(["git", "-C", dir, "diff", "--numstat", base]),
    shellAsync(["git", "-C", dir, "rev-list", "--left-right", "--count", `${originMain}...HEAD`]),
  ]);

  let linesAdded = 0;
  let linesRemoved = 0;
  const changedFiles = new Set<string>();
  if (diffOut) {
    for (const line of diffOut.split("\n")) {
      if (!line) continue;
      const [added, removed, file] = line.split("\t");
      if (file) changedFiles.add(file);
      if (added === "-" || removed === "-") continue; // binary
      linesAdded += Number(added) || 0;
      linesRemoved += Number(removed) || 0;
    }
  }

  // Untracked files aren't in the diff but still count as changed files.
  let untracked = 0;
  for (const line of statusOut.split("\n")) {
    if (line.startsWith("??")) untracked++;
  }
  const filesChanged = changedFiles.size + untracked;

  // Commits ahead(+) or behind(-) origin/main
  let commitsDelta = 0;
  if (aheadBehind) {
    const [behind, ahead] = aheadBehind.split("\t");
    commitsDelta = (Number(ahead) || 0) - (Number(behind) || 0);
  }

  return {
    branch,
    isWorktree: gitDir.includes("/worktrees/"),
    filesChanged,
    linesAdded,
    linesRemoved,
    commitsDelta,
  };
}

/** origin/main, or origin/master if that's what the remote uses. */
async function resolveOriginMain(dir: string): Promise<string> {
  const verified = await shellAsync([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    "origin/main",
  ]);
  return verified ? "origin/main" : "origin/master";
}

/**
 * The commit HEAD diverged from: merge-base with the branch's upstream when it
 * has one, else with origin/main, else HEAD (uncommitted changes only). Using
 * the merge-base rather than the upstream tip keeps remote-only commits out
 * of the stats when the local branch is behind.
 */
async function resolvePushedBase(dir: string, originMain: string): Promise<string> {
  const upstream = await shellAsync([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  // merge-base fails cleanly when the base ref doesn't exist (no remote).
  const mergeBase = await shellAsync([
    "git",
    "-C",
    dir,
    "merge-base",
    "HEAD",
    upstream || originMain,
  ]);
  return mergeBase || "HEAD";
}

// --- Git stat poll ---

const lastPolledSnapshots = new Map<string, string>();

/**
 * Recompute git stats for every session dir on an interval and broadcast when
 * any stat changed. Catches working-tree edits, which (unlike commits) don't
 * touch the .git/HEAD file the watchers track.
 */
export function startGitPoll(ctx: {
  getSessions: () => { dir: string }[] | null;
  getClientCount: () => number;
  broadcastState: () => void;
}): ReturnType<typeof setInterval> {
  return startSessionPoll({
    intervalMs: 1500,
    ...ctx,
    tick: async (sessions) => {
      let changed = false;
      const seen = new Set<string>();
      for (const s of sessions) {
        if (!s.dir || seen.has(s.dir)) continue;
        seen.add(s.dir);
        const snapshot = JSON.stringify(await refreshGitInfo(s.dir));
        if (lastPolledSnapshots.get(s.dir) !== snapshot) {
          lastPolledSnapshots.set(s.dir, snapshot);
          changed = true;
        }
      }
      for (const dir of lastPolledSnapshots.keys()) {
        if (!seen.has(dir)) lastPolledSnapshots.delete(dir);
      }
      return changed;
    },
  });
}

// --- Git HEAD file watchers ---

const gitHeadWatchers = new Map<string, FSWatcher>();

function resolveGitHeadPath(dir: string): string | null {
  if (!dir) return null;
  const gitDir = shell(["git", "-C", dir, "rev-parse", "--git-dir"]);
  if (!gitDir) return null;
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(dir, gitDir);
  const headPath = join(absGitDir, "HEAD");
  return existsSync(headPath) ? headPath : null;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onGitHeadChange(broadcastFn: () => void): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    invalidateGitCache();
    broadcastFn();
  }, 200);
}

export function syncGitWatchers(dirs: { dir: string }[], broadcastFn: () => void): void {
  const currentDirs = new Set<string>();
  for (const s of dirs) {
    if (s.dir) currentDirs.add(s.dir);
  }

  for (const [dir, watcher] of gitHeadWatchers) {
    if (!currentDirs.has(dir)) {
      watcher.close();
      gitHeadWatchers.delete(dir);
    }
  }

  for (const dir of currentDirs) {
    if (gitHeadWatchers.has(dir)) continue;
    const headPath = resolveGitHeadPath(dir);
    if (!headPath) continue;
    try {
      const watcher = watch(headPath, () => onGitHeadChange(broadcastFn));
      gitHeadWatchers.set(dir, watcher);
    } catch (err) {
      consola.debug(`Failed to watch git HEAD at ${headPath}:`, err);
    }
  }
}

export function teardownGitWatchers(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  for (const watcher of gitHeadWatchers.values()) watcher.close();
  gitHeadWatchers.clear();
}
