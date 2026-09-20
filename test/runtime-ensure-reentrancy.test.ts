import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTimeout } from "../src/async-control.js";
import { createAcpRuntime, createAgentRegistry } from "../src/runtime.js";
import { InMemorySessionStore, withTempDir } from "./runtime-test-helpers.js";

const peer = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

for (const { competingEnsure, closed } of [
  { competingEnsure: false, closed: false },
  { competingEnsure: true, closed: false },
  { competingEnsure: false, closed: true },
  { competingEnsure: true, closed: true },
]) {
  test(
    `native control permission can await compatible ensure (competing replacement: ${competingEnsure}, closed: ${closed})`,
    { timeout: 30000 },
    async (t) => {
      await withTempDir("acpx-ensure-callback-", async (directory) => {
        const store = new InMemorySessionStore();
        const pids: number[] = [];
        const options = {
          cwd: directory,
          sessionStore: store,
          agentRegistry: createAgentRegistry({
            overrides: {
              fixture: [
                process.execPath,
                peer,
                "--supports-load-session",
                "--load-session-action",
                "permission edit verify-control",
              ],
            },
          }),
          permissionMode: "deny-all" as const,
          processLifecycle: {
            onSpawned: async ({ pid }: { pid: number }) => {
              pids.push(pid);
            },
          },
        };
        const input = { sessionKey: "callback", agent: "fixture", mode: "persistent" as const };
        const initial = createAcpRuntime(options);
        const handle = await initial.ensureSession(input);
        if (closed) {
          await initial.close({ handle, reason: "closed callback session" });
        }
        await initial.shutdown();
        let callbacks = 0;
        let reused = false;
        let replacement: Promise<unknown> | undefined;
        const runtime = createAcpRuntime({
          ...options,
          onPermissionRequest: async () => {
            callbacks++;
            if (competingEnsure) {
              replacement = runtime.ensureSession({ ...input, cwd: path.join(directory, "new") });
              void replacement.catch(() => {});
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            const same = await runtime.ensureSession(input);
            assert.equal(same.backendSessionId, handle.backendSessionId);
            reused = true;
            return { outcome: "allow_once" };
          },
        });
        const changing = runtime.setMode({ handle, mode: "plan" });
        void changing.catch(() => {});
        try {
          await withTimeout(changing, 10000);
          assert.equal(callbacks, 1);
          assert.equal(reused, true);
          if (replacement) {
            await assert.rejects(replacement, {
              code: "ACP_SESSION_INIT_FAILED",
              message: /unfinished/i,
            });
          }
          assert.equal((await store.load("callback"))?.acpx?.desired_mode_id, "plan");
          assert.equal((await store.load("callback"))?.closed, false);
        } finally {
          t.diagnostic(JSON.stringify({ callbacks, reused }));
          await runtime.shutdown();
          await Promise.allSettled([changing, replacement]);
          for (const pid of pids) {
            assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
          }
        }
      });
    },
  );
}
