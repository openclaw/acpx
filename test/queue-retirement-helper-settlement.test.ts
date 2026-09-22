import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { TimeoutError } from "../src/async-control.js";
import { settleRetirerHelpers } from "./fixtures/queue-retirement-retry.js";

test("retirement worker joins an unreferenced delayed close before reporting", async () => {
  const fixture = new URL("./fixtures/queue-retirement-retry.js", import.meta.url).href;
  // An isolated worker has no test-runner handles to hide the unreferenced wait.
  // The timer models a helper's delayed close; it creates no descendant process.
  const source = `
    import { ChildProcess } from 'node:child_process';
    const { settleRetirerHelpers } = await import(${JSON.stringify(fixture)});
    const events = [];
    const child = new ChildProcess();
    let complete;
    const closed = new Promise(resolve => { complete = resolve; });
    const timer = setTimeout(() => {
      events.push('close');
      complete();
    }, 25).unref();
    child.ref = () => { events.push('ref'); timer.ref(); };
    child.unref = () => { events.push('unref'); timer.unref(); };
    child.kill = () => { events.push('kill'); return false; };
    await settleRetirerHelpers([{ child, closed }]);
    events.push('report');
    process.stdout.write(JSON.stringify(events));
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { timeout: 5_000, killSignal: "SIGKILL" },
  );
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), ["ref", "kill", "close", "unref", "report"]);
});

test("retirement helper settlement bounds missing close and releases every reference", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const references = [0, 0];
  const helpers = references.map((_, index) => {
    const child = new ChildProcess();
    child.ref = () => {
      references[index] += 1;
    };
    child.unref = () => {
      references[index] -= 1;
    };
    child.kill = () => true;
    const closed = index === 0 ? Promise.resolve() : new Promise<void>(() => {});
    return { child, closed };
  });
  const rejected = assert.rejects(settleRetirerHelpers(helpers), TimeoutError);
  assert.deepEqual(references, [1, 1]);
  t.mock.timers.tick(5_000);
  await rejected;
  assert.deepEqual(references, [0, 0]);
});
