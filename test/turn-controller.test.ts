import assert from "node:assert/strict";
import test from "node:test";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "../src/session/queue/owner-turn-controller.js";

test("QueueOwnerTurnController tracks explicit lifecycle states", async () => {
  const controller = createQueueOwnerTurnController();
  assert.equal(controller.lifecycleState, "idle");

  controller.beginTurn();
  assert.equal(controller.lifecycleState, "starting");

  controller.markPromptActive();
  assert.equal(controller.lifecycleState, "active");

  controller.endTurn();
  assert.equal(controller.lifecycleState, "idle");

  controller.beginClosing();
  assert.equal(controller.lifecycleState, "closing");
  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, false);
});

test("QueueOwnerTurnController cancels immediately for active prompts", async () => {
  const controller = createQueueOwnerTurnController();
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
  controller.markPromptActive();

  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, true);
  assert.equal(cancelCalls, 1);
  assert.equal(controller.hasPendingCancel, false);
});

test("QueueOwnerTurnController revokes retry admission while cooperative cancellation waits", async () => {
  const controller = createQueueOwnerTurnController();
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
  controller.markPromptActive();
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
    const controller = createQueueOwnerTurnController();
    controller.beginTurn();
    let active = kind === "active";
    let finishCancel!: (cancelled: boolean) => void;
    const cancellation = new Promise<boolean>((resolve) => {
      finishCancel = resolve;
    });
    controller.setActiveController(
      makeActiveController({
        hasActivePrompt: () => active,
        requestCancelActivePrompt: () => cancellation,
      }),
    );
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
      assert.equal(controller.hasPendingCancel, true);
      assert.equal(nextSignal.reason, nextReason);
    } finally {
      finishCancel(false);
      await oldCancel;
    }
  });
}

test("QueueOwnerTurnController defers cancel while turn is starting", async () => {
  const controller = createQueueOwnerTurnController();
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
  assert.equal(controller.hasPendingCancel, true);

  const beforeActive = await controller.applyPendingCancel();
  assert.equal(beforeActive, false);
  assert.equal(cancelCalls, 0);
  assert.equal(controller.hasPendingCancel, true);

  promptActive = true;
  controller.markPromptActive();
  const afterActive = await controller.applyPendingCancel();
  assert.equal(afterActive, true);
  assert.equal(cancelCalls, 1);
  assert.equal(controller.hasPendingCancel, false);
});

function createQueueOwnerTurnController(): QueueOwnerTurnController {
  return new QueueOwnerTurnController();
}

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
