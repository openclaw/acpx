import assert from "node:assert/strict";
import test from "node:test";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "../src/session/queue/owner-turn-controller.js";

test("QueueOwnerTurnController stops accepting cancellation at turn end or owner close", async () => {
  const controller = new QueueOwnerTurnController();
  assert.equal(await controller.requestCancel(), false);

  const signal = controller.beginTurn();
  assert.equal(await controller.requestCancel(), true);
  assert.equal(signal.aborted, true);
  controller.endTurn();
  assert.equal(await controller.requestCancel(), false);

  controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => true,
      requestCancelActivePrompt: async () => true,
    }),
  );
  controller.beginClosing();
  assert.equal(await controller.requestCancel(), false);
});

test("QueueOwnerTurnController cancels immediately for active prompts", async () => {
  const controller = new QueueOwnerTurnController();
  let cancelCalls = 0;

  controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => true,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return true;
      },
    }),
  );
  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, true);
  assert.equal(cancelCalls, 1);
  assert.equal(await controller.applyPendingCancel(), false);
});

test("QueueOwnerTurnController revokes retry admission while cooperative cancellation waits", async () => {
  const controller = new QueueOwnerTurnController();
  const signal = controller.beginTurn();
  let finishCancel!: (cancelled: boolean) => void;
  const cancellation = new Promise<boolean>((resolve) => {
    finishCancel = resolve;
  });
  let calls = 0;
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => true,
      requestCancelActivePrompt: () => {
        calls += 1;
        assert.equal(
          signal.aborted,
          false,
          "cooperative cancellation starts before abort listeners",
        );
        return cancellation;
      },
    }),
  );
  const accepted = controller.requestCancel();
  try {
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true, "retry admission stops before cancellation settles");
    finishCancel(true);
    assert.equal(await accepted, true);
    controller.endTurn();
    assert.equal(controller.beginTurn().aborted, false, "the successor owns a fresh signal");
  } finally {
    finishCancel(false);
    await accepted;
  }
});

for (const kind of ["active", "deferred"]) {
  test(`QueueOwnerTurnController keeps successor cancellation after an old ${kind} acknowledgement`, async () => {
    const controller = new QueueOwnerTurnController();
    controller.beginTurn();
    let active = kind === "active";
    let finishCancel!: (cancelled: boolean) => void;
    const cancellation = new Promise<boolean>((resolve) => {
      finishCancel = resolve;
    });
    const activeController = makeActiveController({
      hasActivePrompt: () => active,
      requestCancelActivePrompt: () => cancellation,
    });
    controller.setActiveController(activeController);
    if (kind === "deferred") {
      assert.equal(await controller.requestCancel(), true);
      active = true;
    }
    const oldCancel =
      kind === "active" ? controller.requestCancel() : controller.applyPendingCancel();
    try {
      controller.clearActiveController();
      controller.endTurn();
      const nextSignal = controller.beginTurn();
      assert.equal(nextSignal.aborted, false);
      assert.equal(await controller.requestCancel(), true);
      const nextReason: unknown = nextSignal.reason;
      finishCancel(true);
      assert.equal(await oldCancel, true);
      controller.setActiveController(activeController);
      assert.equal(await controller.applyPendingCancel(), true);
      assert.equal(nextSignal.reason, nextReason);
    } finally {
      finishCancel(false);
      await oldCancel;
    }
  });
}

test("QueueOwnerTurnController defers cancel while turn is starting", async () => {
  const controller = new QueueOwnerTurnController();
  let promptActive = false;
  let cancelCalls = 0;

  controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => promptActive,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return promptActive;
      },
    }),
  );

  const accepted = await controller.requestCancel();
  assert.equal(accepted, true);
  assert.equal(cancelCalls, 0);
  const beforeActive = await controller.applyPendingCancel();
  assert.equal(beforeActive, false);
  assert.equal(cancelCalls, 0);
  promptActive = true;
  const afterActive = await controller.applyPendingCancel();
  assert.equal(afterActive, true);
  assert.equal(cancelCalls, 1);
  assert.equal(await controller.applyPendingCancel(), false);
  assert.equal(cancelCalls, 1);
});

type ActiveControllerOverrides = Partial<QueueOwnerActiveSessionController>;

function makeActiveController(
  overrides: ActiveControllerOverrides = {},
): QueueOwnerActiveSessionController {
  return {
    hasActivePrompt: overrides.hasActivePrompt ?? (() => false),
    requestCancelActivePrompt: overrides.requestCancelActivePrompt ?? (async () => false),
    setSessionMode:
      overrides.setSessionMode ??
      (async () => {
        // no-op
      }),
    setSessionModel:
      overrides.setSessionModel ??
      (async () => ({
        configOptions: [],
      })),
    setSessionConfigOption:
      overrides.setSessionConfigOption ?? (async () => ({ configOptions: [] })),
  };
}
