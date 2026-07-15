import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { SERVER_PORT, SERVER_HOST, PID_FILE } from "../shared";
import { SERVER_ERR_LOG } from "../debug";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortOpen(host: string, port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function ensureServer(): Promise<void> {
  if (existsSync(PID_FILE)) {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid) && (await isPortOpen(SERVER_HOST, SERVER_PORT))) {
      return;
    }
    // Stale PID file — remove before spawning a new server
    try {
      unlinkSync(PID_FILE);
    } catch {
      // intentionally ignored: PID file may already be gone
    }
  }

  const proc = Bun.spawn(["ttt", "agentboard", "server"], {
    stdio: ["ignore", "ignore", Bun.file(SERVER_ERR_LOG)],
  });
  proc.unref();

  for (let i = 0; i < 60; i++) {
    await Bun.sleep(50);
    if (await isPortOpen(SERVER_HOST, SERVER_PORT, 100)) return;
  }

  const errLog = existsSync(SERVER_ERR_LOG) ? readFileSync(SERVER_ERR_LOG, "utf-8").trim() : "";
  const detail = errLog || `No error output. Check ${SERVER_ERR_LOG}`;
  throw new Error(`AgentBoard server failed to start:\n${detail}`);
}
