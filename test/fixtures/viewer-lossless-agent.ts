// Wrap the existing echo-only mock; create no descendants or external requests.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const receiptPath = process.argv[2];
const failureDeadlineAt = Number(process.argv[3]);
if (!receiptPath || !Number.isSafeInteger(failureDeadlineAt)) {
  throw new Error("Missing owned receipt path or failure deadline");
}
process.argv.splice(2, 2);
const instanceId = randomUUID();
const record = (kind: string, detail?: number | string) => {
  appendFileSync(
    receiptPath,
    `${JSON.stringify({ instanceId, pid: process.pid, kind, detail })}\n`,
  );
};
record("started", failureDeadlineAt);
process.on("exit", (code) => record("exited", code));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    record("signal", signal);
    process.exit(0);
  });
}
// The parent never infers authority to signal a PID read from this receipt.
// One controller-derived absolute failure deadline covers the entire capture,
// plus producer retirement grace. It does not restart for each peer or turn.
setTimeout(() => process.exit(94), Math.max(0, failureDeadlineAt - Date.now())).unref();
await import("../mock-agent.js");
