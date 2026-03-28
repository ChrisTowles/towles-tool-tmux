import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execSync } from "node:child_process";

import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockCardService,
} from "../helpers/mock-deps";
import { createSessionReconnect } from "../../server/plugins/session-reconnect";

// Track sessions we create so we can clean up
const createdSessions: string[] = [];

function isTmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(name: string): void {
  execSync(`tmux new-session -d -s ${name}`, { stdio: "ignore" });
  createdSessions.push(name);
}

function killTmuxSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name}`, { stdio: "ignore" });
  } catch {
    // session may already be dead
  }
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listCardSessions(): string[] {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}"', {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith("card-"));
  } catch {
    return [];
  }
}

afterAll(() => {
  for (const name of createdSessions) {
    killTmuxSession(name);
  }
});

describe("Session Reconnect Live (real tmux)", { timeout: 30_000 }, () => {
  const tmuxAvailable = isTmuxAvailable();

  describe("real tmux session lifecycle", () => {
    it("creates and detects a live tmux session", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-9001";
      createTmuxSession(sessionName);

      expect(tmuxSessionExists(sessionName)).toBe(true);

      const sessions = listCardSessions();
      expect(sessions).toContain(sessionName);

      killTmuxSession(sessionName);
      expect(tmuxSessionExists(sessionName)).toBe(false);
    });

    it("session disappears from list after kill", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-9002";
      createTmuxSession(sessionName);
      expect(tmuxSessionExists(sessionName)).toBe(true);

      killTmuxSession(sessionName);

      const sessions = listCardSessions();
      expect(sessions).not.toContain(sessionName);
    });
  });

  describe("orphan detection scenarios", () => {
    it("detects session with no matching card as orphan candidate", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-8888";
      createTmuxSession(sessionName);

      const sessions = listCardSessions();
      expect(sessions).toContain(sessionName);

      // In reconnect logic, if card 8888 doesn't exist in DB, this session is orphaned.
      // We verify the session name parsing extracts the correct card ID.
      const match = sessionName.match(/^card-(\d+)$/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(8888);

      killTmuxSession(sessionName);
    });

    it("handles multiple orphaned sessions", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessions = ["card-7001", "card-7002", "card-7003"];
      for (const s of sessions) {
        createTmuxSession(s);
      }

      const liveSessions = listCardSessions();
      for (const s of sessions) {
        expect(liveSessions).toContain(s);
      }

      // Clean up
      for (const s of sessions) {
        killTmuxSession(s);
      }

      // Verify all gone
      const afterSessions = listCardSessions();
      for (const s of sessions) {
        expect(afterSessions).not.toContain(s);
      }
    });
  });

  describe("race condition: session dies between list and check", () => {
    it("session listed but dies before has-session check", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-6001";
      createTmuxSession(sessionName);

      // Simulate: list shows it
      const sessions = listCardSessions();
      expect(sessions).toContain(sessionName);

      // Kill it (simulates it dying between list and check)
      killTmuxSession(sessionName);

      // Now has-session should return false
      expect(tmuxSessionExists(sessionName)).toBe(false);

      // This is the edge case the reconnect plugin handles:
      // it finds the session in list, but by the time it calls sessionExists(),
      // the session is gone. The plugin should mark the card as failed.
    });
  });
});

describe("Session Reconnect After Server Restart (real tmux + mocked DB)", { timeout: 30_000 }, () => {
  const tmuxAvailable = isTmuxAvailable();

  it("resumes capture for running card with live session on restart", async ({ skip }) => {
    if (!tmuxAvailable) skip();

    const cardId = 5001;
    const sessionName = `card-${cardId}`;

    // Create a real tmux session simulating a running agent
    createTmuxSession(sessionName);
    expect(tmuxSessionExists(sessionName)).toBe(true);

    // Mock deps with real tmux manager behavior
    const mockDb = createMockDb();
    const mockEventBus = createMockEventBus();
    const mockCardService = createMockCardService();

    // First select: lookup card by ID from tmux session
    // Second select: find all running cards
    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        // Card exists in DB with running status
        chain.where = vi.fn().mockResolvedValue([{ id: cardId, status: "running" }]);
      } else {
        // Only this card is running
        chain.where = vi.fn().mockResolvedValue([{ id: cardId, status: "running" }]);
      }
      return chain;
    });

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    // Real tmux manager that uses actual tmux
    const realTmuxManager = {
      isAvailable: () => true,
      listSessions: () => listCardSessions(),
      sessionExists: (name: string) => tmuxSessionExists(name),
      startCapture: vi.fn(),
      killSession: (name: string) => killTmuxSession(name),
    };

    // Simulate server restart by running session reconnect
    await createSessionReconnect({
      db: mockDb as never,
      tmuxManager: realTmuxManager,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
      cardService: mockCardService as never,
    });

    // Capture should be resumed for the running card's session
    expect(realTmuxManager.startCapture).toHaveBeenCalledWith(sessionName, expect.any(Function));

    // Card should NOT be marked failed
    expect(mockCardService.markFailed).not.toHaveBeenCalled();

    // logEvent should be called for reconnection
    expect(mockCardService.logEvent).toHaveBeenCalledWith(
      cardId,
      "tmux_session_reconnected",
      expect.stringContaining(sessionName),
    );

    // Cleanup
    killTmuxSession(sessionName);
  });

  it("marks running card as failed when session is missing on restart", async ({ skip }) => {
    if (!tmuxAvailable) skip();

    const cardId = 5002;
    // No tmux session created — simulates session that died

    const mockDb = createMockDb();
    const mockEventBus = createMockEventBus();
    const mockCardService = createMockCardService();

    // First select: no sessions found matching any card
    // Second select: find all running cards — returns our card
    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([]);
      } else {
        chain.where = vi.fn().mockResolvedValue([{ id: cardId, status: "running" }]);
      }
      return chain;
    });

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    const realTmuxManager = {
      isAvailable: () => true,
      listSessions: () => listCardSessions(),
      sessionExists: (name: string) => tmuxSessionExists(name),
      startCapture: vi.fn(),
      killSession: (name: string) => killTmuxSession(name),
    };

    await createSessionReconnect({
      db: mockDb as never,
      tmuxManager: realTmuxManager,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
      cardService: mockCardService as never,
    });

    // Card should be marked failed — no session to reconnect to
    expect(mockCardService.markFailed).toHaveBeenCalledWith(cardId, expect.any(String));

    // Capture should NOT be started
    expect(realTmuxManager.startCapture).not.toHaveBeenCalled();
  });

  it("kills orphaned session when card status is not running", async ({ skip }) => {
    if (!tmuxAvailable) skip();

    const cardId = 5003;
    const sessionName = `card-${cardId}`;

    // Create session but card is not in running state
    createTmuxSession(sessionName);
    expect(tmuxSessionExists(sessionName)).toBe(true);

    const mockDb = createMockDb();
    const mockEventBus = createMockEventBus();
    const mockCardService = createMockCardService();

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        // Card exists but is in review_ready status (completed)
        chain.where = vi.fn().mockResolvedValue([{ id: cardId, status: "review_ready" }]);
      } else {
        // No running cards
        chain.where = vi.fn().mockResolvedValue([]);
      }
      return chain;
    });

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    let killedSession: string | null = null;
    const realTmuxManager = {
      isAvailable: () => true,
      listSessions: () => listCardSessions(),
      sessionExists: (name: string) => tmuxSessionExists(name),
      startCapture: vi.fn(),
      killSession: (name: string) => {
        killedSession = name;
        killTmuxSession(name);
      },
    };

    await createSessionReconnect({
      db: mockDb as never,
      tmuxManager: realTmuxManager,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
      cardService: mockCardService as never,
    });

    // Session should be killed since card is not running
    expect(killedSession).toBe(sessionName);
    expect(tmuxSessionExists(sessionName)).toBe(false);

    // logEvent should record the orphaned session was killed
    expect(mockCardService.logEvent).toHaveBeenCalledWith(
      cardId,
      "tmux_session_orphaned_killed",
      expect.stringContaining(sessionName),
    );
  });
});

describe("Session Reconnect Plugin (mocked)", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockCardService: {
    updateStatus: ReturnType<typeof vi.fn>;
    moveToColumn: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
    markComplete: ReturnType<typeof vi.fn>;
    logEvent: ReturnType<typeof vi.fn>;
    resolveDependencies: ReturnType<typeof vi.fn>;
  };
  let mockTmuxManager: {
    isAvailable: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    sessionExists: ReturnType<typeof vi.fn>;
    startCapture: ReturnType<typeof vi.fn>;
    killSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockCardService = createMockCardService();
    mockTmuxManager = {
      isAvailable: vi.fn().mockReturnValue(true),
      listSessions: vi.fn().mockReturnValue([]),
      sessionExists: vi.fn().mockReturnValue(true),
      startCapture: vi.fn(),
      killSession: vi.fn(),
    };
  });

  function runPlugin() {
    return createSessionReconnect({
      db: mockDb as never,
      tmuxManager: mockTmuxManager,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
      cardService: mockCardService as never,
    });
  }

  it("resumes capture for running card and marks orphaned card failed", async () => {
    // Scenario: card-3 is running with a live session, card-50 is running with no session
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-3"]);
    mockTmuxManager.sessionExists.mockReturnValue(true);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([{ id: 3, status: "running" }]);
      } else {
        chain.where = vi.fn().mockResolvedValue([
          { id: 3, status: "running" },
          { id: 50, status: "running" },
        ]);
      }
      return chain;
    });

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    await runPlugin();

    // card-3 should get capture resumed (it has a live session)
    expect(mockTmuxManager.startCapture).toHaveBeenCalledWith("card-3", expect.any(Function));

    // card-50 should be marked failed (running but no session)
    expect(mockCardService.markFailed).toHaveBeenCalledWith(50, expect.any(String));
  });

  it("handles session that dies between list and existence check", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-15"]);
    mockTmuxManager.sessionExists.mockReturnValue(false);

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([{ id: 15, status: "running" }]);
      } else {
        chain.where = vi.fn().mockResolvedValue([{ id: 15 }]);
      }
      return chain;
    });

    await runPlugin();

    // Card should be marked failed since session died
    expect(mockCardService.markFailed).toHaveBeenCalledWith(15, expect.any(String));
  });
});
