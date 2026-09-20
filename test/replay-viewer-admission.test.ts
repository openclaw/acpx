import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import {
  createReplayViewerServer,
  type ReplayViewerServer,
} from "../examples/flows/replay-viewer/server/viewer-server.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../examples/flows/replay-viewer/server.js", import.meta.url),
);

async function withViewer(host: string, run: (viewer: ReplayViewerServer) => Promise<void>) {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-admission-"));
  await fs.mkdir(path.join(runsDir, "synthetic"));
  await fs.writeFile(path.join(runsDir, "synthetic", "marker.txt"), "synthetic viewer marker");
  let viewer: ReplayViewerServer | undefined;
  try {
    viewer = await createReplayViewerServer({
      host,
      port: 0,
      runsDir,
      disableDependencyOptimization: true,
    });
    await run(viewer);
  } finally {
    await viewer?.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }
}

async function request(
  viewer: ReplayViewerServer,
  target: string,
  headers: http.OutgoingHttpHeaders = {},
  options: { hostname?: string; method?: string; setHost?: boolean } = {},
): Promise<{ status: number | undefined; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: viewer.port, path: target, headers, ...options },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => resolve({ status: response.statusCode, body }));
        response.once("error", reject);
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("viewer request timed out")));
    req.once("error", reject);
    req.end();
  });
}

async function upgrade(
  viewer: ReplayViewerServer,
  headers: http.OutgoingHttpHeaders,
  hostname = "127.0.0.1",
): Promise<{ status: number | undefined; snapshot: boolean }> {
  return await new Promise((resolve, reject) => {
    const host = hostname.includes(":") ? `[${hostname}]` : hostname;
    const socket = new WebSocket(`ws://${host}:${viewer.port}/api/live`, {
      headers,
      handshakeTimeout: 3000,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("viewer snapshot timed out"));
    }, 3000);
    const finish = (status: number | undefined, snapshot: boolean) => {
      clearTimeout(timer);
      socket.terminate();
      resolve({ status, snapshot });
    };
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode, false);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("message", (data) => {
      assert.ok(Buffer.isBuffer(data));
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === "ready") {
        socket.send(JSON.stringify({ type: "subscribe_runs" }));
      }
      if (message.type === "runs_snapshot") {
        finish(101, true);
      }
    });
  });
}

function rejectedHeaders(port: number): Record<string, http.OutgoingHttpHeaders> {
  const authority = `127.0.0.1:${port}`;
  const origin = `http://${authority}`;
  return {
    "foreign Origin": { Origin: "https://foreign.invalid" },
    "foreign Host": { Host: `foreign.invalid:${port}` },
    "matching foreign Host and Origin": {
      Host: `foreign.invalid:${port}`,
      Origin: `http://foreign.invalid:${port}`,
    },
    "foreign Host with local Origin": { Host: `foreign.invalid:${port}`, Origin: origin },
    "wrong port": { Host: "127.0.0.1:0" },
    "host suffix": { Host: `127.0.0.1.foreign.invalid:${port}` },
    "userinfo authority": { Host: `person@${authority}` },
    "authority path": { Host: `${authority}/` },
    "authority query": { Host: `${authority}?x=1` },
    "authority fragment": { Host: `${authority}#part` },
    "null Origin": { Origin: "null" },
    "empty Origin": { Origin: "" },
    "Origin path": { Origin: `${origin}/path` },
    "Origin list": { Origin: `${origin} https://foreign.invalid` },
    "duplicate Origin": { Origin: [origin, origin] },
    "forwarded headers": {
      Host: `foreign.invalid:${port}`,
      "X-Forwarded-Host": authority,
      "X-Forwarded-Proto": "http",
      Forwarded: `host=${authority}`,
    },
  };
}

test("integrated viewer checks Host and Origin before HTTP and WebSocket access", async (t) => {
  await withViewer("127.0.0.1", async (viewer) => {
    for (const [name, headers] of Object.entries(rejectedHeaders(viewer.port))) {
      await t.test(`${name}: HTTP`, async () => {
        for (const route of [
          "/api/health",
          "/api/runs",
          "/api/runs/synthetic/files/marker.txt",
          "/",
        ]) {
          const result = await request(viewer, route, headers);
          assert.ok(
            result.status === 400 || result.status === 403,
            `${route} returned ${result.status}`,
          );
          assert.equal(result.body.includes("synthetic viewer marker"), false);
        }
      });
      await t.test(`${name}: WebSocket`, async () => {
        const socket = await upgrade(viewer, headers);
        assert.ok(socket.status === 400 || socket.status === 403);
        assert.equal(socket.snapshot, false);
      });
    }
    await t.test("missing Host", async () => {
      const result = await request(viewer, "/api/health", {}, { setHost: false });
      assert.ok(result.status === 400 || result.status === 403);
    });
  });
});

test("duplicate Host lines are rejected by the real listener", async () => {
  await withViewer("127.0.0.1", async (viewer) => {
    for (const target of ["/api/health", "/api/live"]) {
      const result = await new Promise<number>((resolve, reject) => {
        const socket = net.createConnection(viewer.port, "127.0.0.1");
        socket.setTimeout(3000, () => socket.destroy(new Error("duplicate Host probe timed out")));
        socket.once("error", reject);
        socket.once("close", () =>
          reject(new Error("duplicate Host probe closed without response")),
        );
        socket.once("connect", () => {
          const upgradeHeaders =
            target === "/api/live"
              ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLWtleS0xMg==\r\n"
              : "Connection: close\r\n";
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${viewer.port}\r\nHost: 127.0.0.1:${viewer.port}\r\n${upgradeHeaders}\r\n`,
          );
        });
        socket.once("data", (data: Buffer) => {
          const status = Number(data.toString("utf8").split(" ")[1]);
          socket.destroy();
          resolve(status);
        });
      });
      assert.ok(result === 400 || result === 403, `${target} returned ${result}`);
    }
  });
});

test("foreign-origin shutdown is denied before closing the integrated viewer", async () => {
  await withViewer("127.0.0.1", async (viewer) => {
    const denied = await request(
      viewer,
      "/api/control/shutdown",
      { Origin: "https://foreign.invalid", "Content-Type": "text/plain" },
      { method: "POST" },
    );
    assert.equal(denied.status, 403);
    assert.equal((await request(viewer, "/api/health")).status, 200);
    assert.equal(
      (await request(viewer, "/api/control/shutdown", {}, { method: "POST" })).status,
      200,
    );
  });
});

for (const host of ["127.0.0.1", "0.0.0.0", "::"]) {
  test(`integrated ${host} viewer keeps local native and same-origin browser access`, async () => {
    await withViewer(host, async (viewer) => {
      for (const name of ["127.0.0.1", "localhost"]) {
        const authority = `${name}:${viewer.port}`;
        for (const headers of [
          { Host: authority },
          { Host: authority, Origin: `http://${authority}` },
        ]) {
          assert.equal((await request(viewer, "/api/health", headers)).status, 200);
          assert.equal(
            (await request(viewer, "/api/runs/synthetic/files/marker.txt", headers)).body,
            "synthetic viewer marker",
          );
          assert.deepEqual(await upgrade(viewer, headers), { status: 101, snapshot: true });
        }
      }
    });
  });
}

test("IPv6 viewer advertises a valid origin and supports CLI status and stop", async (t) => {
  try {
    await withViewer("::1", async (viewer) => {
      assert.equal(new URL(viewer.baseUrl).hostname, "[::1]");
      const headers = { Origin: viewer.baseUrl };
      assert.equal(
        (await request(viewer, "/api/health", headers, { hostname: "::1" })).status,
        200,
      );
      assert.deepEqual(await upgrade(viewer, headers, "::1"), { status: 101, snapshot: true });
      const args = ["--host", "::1", "--port", String(viewer.port)];
      const status = await execFileAsync(process.execPath, [cliPath, "status", ...args], {
        timeout: 5000,
      });
      assert.ok(status.stdout.includes(`Viewer is running at ${viewer.baseUrl}/`));
      const stopped = await execFileAsync(process.execPath, [cliPath, "stop", ...args], {
        timeout: 5000,
      });
      assert.ok(stopped.stdout.includes(`Stopped viewer at ${viewer.baseUrl}/`));
    });
  } catch (error) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("IPv6 loopback unavailable on this host");
      return;
    }
    throw error;
  }
});

test("an explicitly configured localhost viewer accepts its own origin", async () => {
  await withViewer("localhost", async (viewer) => {
    const headers = { Origin: viewer.baseUrl };
    assert.equal(
      (await request(viewer, "/api/health", headers, { hostname: "localhost" })).status,
      200,
    );
    assert.deepEqual(await upgrade(viewer, headers, "localhost"), { status: 101, snapshot: true });
  });
});

test("invalid viewer origins fail before allocating startup resources", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const {createReplayViewerServer} = await import(process.argv[1]);
    try { await createReplayViewerServer({host:'',port:0,disableDependencyOptimization:true}); }
    catch(error) { process.stderr.write(error.code+'\\n'); process.exitCode=1; }
  `,
        new URL("../examples/flows/replay-viewer/server/viewer-server.js", import.meta.url).href,
      ],
      { timeout: 5000, killSignal: "SIGKILL" },
    ),
    { code: 1, killed: false, signal: null, stderr: "ERR_INVALID_URL\n" },
  );
});
