import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { TimeoutError } from "../src/async-control.js";
import { FlowRunner, compute, defineFlow } from "../src/flows/runtime.js";
import type { FlowRunStore } from "../src/flows/store.js";
import { withTempHome } from "./runtime-test-helpers.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const boundary of ["serialization", "artifact"] as const) {
  test(`node deadline remains active during output ${boundary}`, async (t) => {
    await withTempHome("acpx-flow-finalization-", async (home) => {
      const runner = new FlowRunner({
        outputRoot: path.join(home, "runs"),
        permissionMode: "deny-all",
        resolveAgent: () => ({ agentName: "unused", agentCommand: "unused", cwd: home }),
      });
      const entered = gate();
      const releaseWrite = gate();
      const store = (runner as unknown as { store: FlowRunStore }).store;
      const write = store.writeArtifact.bind(store);
      t.mock.method(
        store,
        "writeArtifact",
        async (...args: Parameters<FlowRunStore["writeArtifact"]>) => {
          if (args[3].nodeId === "work") {
            entered.release();
            await releaseWrite.promise;
          }
          return await write(...args);
        },
      );
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let serialized = false;
      let settled = false;
      const running = runner
        .run(
          defineFlow({
            name: "output-deadline",
            startAt: "work",
            nodes: {
              work: compute({
                timeoutMs: 20_000,
                heartbeatMs: 0,
                run: () =>
                  boundary === "artifact"
                    ? "synthetic large output".repeat(30)
                    : {
                        toJSON() {
                          serialized = true;
                          t.mock.timers.tick(20_000);
                          return { label: "synthetic output" };
                        },
                      },
              }),
            },
            edges: [],
          }),
          {},
        )
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      try {
        if (boundary === "artifact") {
          await entered.promise;
          t.mock.timers.tick(20_000);
          await nextTurn();
          assert.equal(
            settled,
            false,
            "admitted output write must finish before timeout publication",
          );
          releaseWrite.release();
        }
        const error = await running;
        assert.ok(error instanceof TimeoutError);
        if (boundary === "serialization") {
          assert.equal(serialized, true);
        }
        const runDir = path.join(home, "runs", (await fs.readdir(path.join(home, "runs")))[0]);
        const state = JSON.parse(
          await fs.readFile(path.join(runDir, "projections/run.json"), "utf8"),
        ) as { status: string; outputs: object };
        assert.equal(state.status, "timed_out");
        assert.deepEqual(state.outputs, {});
      } finally {
        releaseWrite.release();
        await running;
      }
    });
  });
}
