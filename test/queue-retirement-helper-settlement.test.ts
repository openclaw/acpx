import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

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
