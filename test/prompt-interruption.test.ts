import assert from "node:assert/strict";
import test from "node:test";
import { InterruptedError } from "../src/async-control.js";
import { withPromptInterrupts } from "../src/cli/prompt-interruption.js";

function pending(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  test(`foreground ${signalName} cancels the exact admitted request before detaching`, async () => {
    const before = process.listenerCount(signalName);
    let submittedId: string | undefined;
    let observer: AbortSignal | undefined;
    const cancelled: string[] = [];
    await assert.rejects(
      withPromptInterrupts(
        async ({ requestId, signal, onQueueAccepted }) => {
          submittedId = requestId;
          observer = signal;
          const result = pending(signal);
          onQueueAccepted();
          process.emit(signalName);
          return await result;
        },
        async (requestId) => {
          assert.equal(observer?.aborted, false);
          cancelled.push(requestId);
        },
      ),
      InterruptedError,
    );
    assert.deepEqual(cancelled, [submittedId]);
    assert.equal(observer?.aborted, true);
    assert.equal(process.listenerCount(signalName), before);
  });
}

test("foreground interrupt before acknowledgement waits for admission, cancelling only once", async () => {
  let cancels = 0;
  await assert.rejects(
    withPromptInterrupts(
      async ({ signal, onQueueAccepted }) => {
        const result = pending(signal);
        process.emit("SIGINT");
        process.emit("SIGINT");
        process.emit("SIGTERM");
        await Promise.resolve();
        assert.equal(cancels, 0);
        assert.equal(signal.aborted, false, "do not detach before learning the admission outcome");
        onQueueAccepted();
        return await result;
      },
      async () => {
        cancels++;
      },
    ),
    InterruptedError,
  );
  assert.equal(cancels, 1);
});

test("foreground interrupt wins a normal completion race", async () => {
  let cancels = 0;
  await assert.rejects(
    withPromptInterrupts(
      async ({ onQueueAccepted }) => {
        onQueueAccepted();
        process.emit("SIGINT");
        return "completed concurrently";
      },
      async () => {
        cancels++;
      },
    ),
    InterruptedError,
  );
  assert.equal(cancels, 1);
});

test("foreground interrupt reports targeted cancellation failure instead of claiming success", async () => {
  const failure = new Error("owner does not support request-targeted cancellation");
  let observer: AbortSignal | undefined;
  await assert.rejects(
    withPromptInterrupts(
      async ({ signal, onQueueAccepted }) => {
        observer = signal;
        const result = pending(signal);
        onQueueAccepted();
        process.emit("SIGINT");
        return await result;
      },
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(observer?.aborted, true);
});

test("foreground preserves uncertain pre-acknowledgement failure after interrupt", async () => {
  const failure = new Error("outcome unknown");
  let cancels = 0;
  await assert.rejects(
    withPromptInterrupts(
      async () => {
        process.emit("SIGINT");
        throw failure;
      },
      async () => {
        cancels++;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(cancels, 0);
});

for (const stalledPhase of ["admission", "cancel"] as const) {
  test(`foreground interruption bounds stalled ${stalledPhase} and reports uncertainty`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let accepted: (() => void) | undefined;
    let cancels = 0;
    const result = withPromptInterrupts(
      async ({ signal, onQueueAccepted }) => {
        accepted = onQueueAccepted;
        if (stalledPhase === "cancel") {
          onQueueAccepted();
        }
        return await pending(signal);
      },
      async () => {
        cancels++;
        return await new Promise<void>(() => {});
      },
    );
    const rejected = assert.rejects(result, {
      message:
        "Timed out cancelling foreground prompt; request outcome is unknown. Inspect the same session with status, sessions history, or sessions watch before resubmitting.",
    });
    process.emit("SIGINT");
    await Promise.resolve();
    t.mock.timers.tick(2_500);
    await rejected;
    assert.equal(cancels, stalledPhase === "cancel" ? 1 : 0);
    accepted?.();
    await Promise.resolve();
    assert.equal(
      cancels,
      stalledPhase === "cancel" ? 1 : 0,
      "no late cancellation after abandoning admission",
    );
  });
}

test("normal foreground success and failure preserve results without cancellation or listeners", async () => {
  const before = ["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s));
  const cancel = async () => {
    assert.fail("unexpected cancel");
  };
  assert.equal(await withPromptInterrupts(async () => 42, cancel), 42);
  const failure = new Error("submission failed");
  await assert.rejects(
    withPromptInterrupts(async () => {
      throw failure;
    }, cancel),
    (error) => error === failure,
  );
  assert.deepEqual(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s)),
    before,
  );
});
