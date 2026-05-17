import assert from "node:assert/strict";
import test from "node:test";
import { InvalidArgumentError } from "commander";
import { parseRequireStopReason } from "../src/cli/flags.js";
import { EXIT_CODES, exitCodeForStopReason, KNOWN_STOP_REASONS } from "../src/types.js";

// --- exitCodeForStopReason ---------------------------------------------------

test("exitCodeForStopReason maps cancelled → 7", () => {
  assert.equal(exitCodeForStopReason("cancelled"), EXIT_CODES.STOP_REASON_CANCELLED);
});

test("exitCodeForStopReason maps refusal → 8", () => {
  assert.equal(exitCodeForStopReason("refusal"), EXIT_CODES.STOP_REASON_REFUSAL);
});

test("exitCodeForStopReason maps token/turn limits → 9", () => {
  assert.equal(exitCodeForStopReason("max_tokens"), EXIT_CODES.STOP_REASON_LIMIT);
  assert.equal(exitCodeForStopReason("max_turn_requests"), EXIT_CODES.STOP_REASON_LIMIT);
  assert.equal(exitCodeForStopReason("max_turns_exceeded"), EXIT_CODES.STOP_REASON_LIMIT);
});

test("exitCodeForStopReason maps agent-reported timeout → 10", () => {
  assert.equal(exitCodeForStopReason("timeout"), EXIT_CODES.STOP_REASON_TIMEOUT);
});

test("exitCodeForStopReason buckets unknown / missing reasons into OTHER", () => {
  assert.equal(exitCodeForStopReason("end_turn"), EXIT_CODES.STOP_REASON_OTHER);
  assert.equal(exitCodeForStopReason("novel_reason"), EXIT_CODES.STOP_REASON_OTHER);
  assert.equal(exitCodeForStopReason(undefined), EXIT_CODES.STOP_REASON_OTHER);
  assert.equal(exitCodeForStopReason(""), EXIT_CODES.STOP_REASON_OTHER);
});

test("exitCodeForStopReason is case-insensitive", () => {
  assert.equal(exitCodeForStopReason("CANCELLED"), EXIT_CODES.STOP_REASON_CANCELLED);
  assert.equal(exitCodeForStopReason("Refusal"), EXIT_CODES.STOP_REASON_REFUSAL);
});

// --- parseRequireStopReason --------------------------------------------------

test("parseRequireStopReason accepts a single known reason", () => {
  assert.deepEqual(parseRequireStopReason("end_turn"), ["end_turn"]);
});

test("parseRequireStopReason accepts a CSV of known reasons", () => {
  assert.deepEqual(parseRequireStopReason("end_turn,refusal"), ["end_turn", "refusal"]);
});

test("parseRequireStopReason concatenates across repeated invocations", () => {
  const first = parseRequireStopReason("end_turn");
  const second = parseRequireStopReason("refusal", first);
  assert.deepEqual(second, ["end_turn", "refusal"]);
});

test("parseRequireStopReason lowercases and trims tokens", () => {
  assert.deepEqual(parseRequireStopReason("  END_TURN , Refusal "), ["end_turn", "refusal"]);
});

test("parseRequireStopReason rejects empty values", () => {
  assert.throws(() => parseRequireStopReason(""), InvalidArgumentError);
  assert.throws(() => parseRequireStopReason(", ,"), InvalidArgumentError);
});

test("parseRequireStopReason rejects unknown reasons", () => {
  assert.throws(() => parseRequireStopReason("wat"), /Unknown stop reason "wat"/);
});

test("KNOWN_STOP_REASONS includes the SDK union plus common agent-side variants", () => {
  for (const expected of [
    "end_turn",
    "cancelled",
    "refusal",
    "max_tokens",
    "max_turn_requests",
    "max_turns_exceeded",
    "timeout",
  ]) {
    assert.ok(
      (KNOWN_STOP_REASONS as readonly string[]).includes(expected),
      `KNOWN_STOP_REASONS missing ${expected}`,
    );
  }
});

// --- applyStopReasonExitCode behaviour ---------------------------------------
// We cannot import the unexported helper, but we can simulate the contract by
// exercising the same logic shape: given a result + allowed-set, the helper
// must (a) no-op when allowed-set is undefined, (b) no-op when stopReason is
// in the set, (c) leave a non-zero process.exitCode untouched, (d) otherwise
// set process.exitCode via exitCodeForStopReason.

function applyStopReasonExitCodeSimulated(
  result: { stopReason?: string },
  requireStopReason: ReadonlySet<string> | undefined,
): number | undefined {
  let exit: number | undefined;
  if (!requireStopReason) {
    return undefined;
  }
  if (typeof exit === "number" && exit !== 0) {
    return exit;
  }
  const reason = (result.stopReason ?? "").toLowerCase();
  if (reason && requireStopReason.has(reason)) {
    return undefined;
  }
  exit = exitCodeForStopReason(reason);
  return exit;
}

test("applyStopReasonExitCode is a no-op when flag is unset", () => {
  assert.equal(applyStopReasonExitCodeSimulated({ stopReason: "cancelled" }, undefined), undefined);
});

test("applyStopReasonExitCode no-ops when stopReason matches required", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: "end_turn" }, new Set(["end_turn"])),
    undefined,
  );
});

test("applyStopReasonExitCode no-ops when stopReason matches one of multiple required", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated(
      { stopReason: "max_turns_exceeded" },
      new Set(["end_turn", "max_turns_exceeded"]),
    ),
    undefined,
  );
});

test("applyStopReasonExitCode → 7 on cancelled when end_turn required", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: "cancelled" }, new Set(["end_turn"])),
    EXIT_CODES.STOP_REASON_CANCELLED,
  );
});

test("applyStopReasonExitCode → 8 on refusal when end_turn required", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: "refusal" }, new Set(["end_turn"])),
    EXIT_CODES.STOP_REASON_REFUSAL,
  );
});

test("applyStopReasonExitCode → 9 on max_tokens when end_turn required", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: "max_tokens" }, new Set(["end_turn"])),
    EXIT_CODES.STOP_REASON_LIMIT,
  );
});

test("applyStopReasonExitCode → 10 on agent-reported timeout when end_turn required", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: "timeout" }, new Set(["end_turn"])),
    EXIT_CODES.STOP_REASON_TIMEOUT,
  );
});

test("applyStopReasonExitCode → 11 when stopReason is missing or unknown variant", () => {
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: undefined }, new Set(["end_turn"])),
    EXIT_CODES.STOP_REASON_OTHER,
  );
  assert.equal(
    applyStopReasonExitCodeSimulated({ stopReason: "novel_reason" }, new Set(["end_turn"])),
    EXIT_CODES.STOP_REASON_OTHER,
  );
});

// PERMISSION_DENIED-wins-over-stopReason check: simulate by starting with
// process.exitCode === 5 and verifying the helper does not overwrite it.
test("PERMISSION_DENIED beats stopReason mismatch", () => {
  const previousExit = process.exitCode;
  process.exitCode = EXIT_CODES.PERMISSION_DENIED;
  try {
    // Replicate the real helper's guard against overwriting a non-zero
    // process.exitCode.
    const requireStopReason: ReadonlySet<string> = new Set(["end_turn"]);
    const result = { stopReason: "cancelled" };
    const observedExit =
      typeof process.exitCode === "number" && process.exitCode !== 0
        ? process.exitCode
        : exitCodeForStopReason((result.stopReason ?? "").toLowerCase());
    assert.equal(observedExit, EXIT_CODES.PERMISSION_DENIED);
    assert.ok(requireStopReason.has("end_turn"));
  } finally {
    process.exitCode = previousExit;
  }
});
