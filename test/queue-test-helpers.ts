import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type QueuePaths = {
  lockPath: string;
  socketPath: string;
};

export function queuePaths(homeDir: string, sessionId: string): QueuePaths {
  const queueDir = path.join(homeDir, ".acpx", "queues");
  const queueKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\acpx-${queueKey}`
      : path.join(queueDir, `${queueKey}.sock`);
  const lockPath = path.join(queueDir, `${queueKey}.lock`);
  return {
    lockPath,
    socketPath,
  };
}

export async function withTempHome(
  run: (homeDir: string) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-test-home-"));
  process.env.HOME = tempHome;

  try {
    await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

export async function startKeeperProcess(): Promise<ReturnType<typeof spawn>> {
  const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  await once(keeper, "spawn");
  return keeper;
}

export function stopProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
  }
}

export async function writeQueueOwnerLock(options: {
  lockPath: string;
  pid: number | undefined;
  sessionId: string;
  socketPath: string;
  ownerGeneration?: number;
  queueDepth?: number;
  createdAt?: string;
  heartbeatAt?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const createdAt = options.createdAt ?? now;
  const heartbeatAt = options.heartbeatAt ?? createdAt;
  await fs.mkdir(path.dirname(options.lockPath), { recursive: true });
  await fs.writeFile(
    options.lockPath,
    `${JSON.stringify({
      pid: options.pid,
      sessionId: options.sessionId,
      socketPath: options.socketPath,
      createdAt,
      heartbeatAt,
      ownerGeneration:
        options.ownerGeneration ??
        Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
      queueDepth: options.queueDepth ?? 0,
    })}\n`,
    "utf8",
  );
}

export async function cleanupOwnerArtifacts(options: {
  socketPath: string;
  lockPath: string;
}): Promise<void> {
  if (process.platform !== "win32") {
    await fs.rm(options.socketPath, { force: true });
  }
  await fs.rm(options.lockPath, { force: true });
}

export async function listenServer(
  server: net.Server,
  socketPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
