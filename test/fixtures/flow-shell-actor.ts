import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [dir, mode, role, failure] = process.argv.slice(2);
assert.ok(dir && path.isAbsolute(dir), "actor requires an absolute fixture directory");
assert.ok(mode, "actor requires a fixture mode");
assert.ok(
  ["interrupt", "late-executor", "background", "wrapper-exit", "one-interrupt"].includes(mode),
  "unknown fixture mode",
);
assert.ok(role === "wrapper" || role === "descendant", "unknown actor role");
assert.ok(
  failure === "" || failure === "readiness" || failure === "body" || failure === "publication",
  "unknown fixture failure",
);
assert.ok(
  role === "wrapper" || mode === "background" || mode === "wrapper-exit",
  "this mode does not have a descendant",
);

const pidFile = path.join(dir, "pid");
const marker = path.join(dir, "signal");
const mark = (value: string) => writeFileSync(marker, value);
const publish = () => {
  if (failure !== "readiness") {
    writeFileSync(pidFile, String(process.pid));
  }
};
const stopOnInterrupt = () => {
  mark("SIGINT");
  process.exit(0);
};

// Keep the forbidden late-launch marker independent of actor identity setup.
if (mode === "late-executor") {
  mark("launched");
  process.exit(0);
}

const { runActor } = await import("./flow-shell-host.js");
await runActor(dir, role, () => {
  if (role === "descendant") {
    if (mode === "wrapper-exit") {
      process.on("SIGINT", () => {});
      process.on("SIGTERM", () => {});
    } else {
      process.on("SIGINT", stopOnInterrupt);
    }
    publish();
    setInterval(() => {}, 1_000);
    return;
  }

  if (mode === "wrapper-exit" || mode === "background") {
    if (mode === "wrapper-exit") {
      process.on("SIGINT", stopOnInterrupt);
    }
    spawn(process.execPath, [fileURLToPath(import.meta.url), dir, mode, "descendant", failure], {
      stdio: "ignore",
      detached: mode === "wrapper-exit",
    });
    if (mode === "background") {
      process.exit(0);
    }
  } else if (mode === "one-interrupt") {
    let count = 0;
    process.on("SIGINT", () => {
      if (++count > 1) {
        process.exit(2);
      }
      setTimeout(() => {
        mark(String(count));
        process.exit(0);
      }, 200);
    });
    publish();
  } else {
    process.on("SIGINT", stopOnInterrupt);
    process.on("SIGTERM", () => {});
    publish();
  }
  setInterval(() => {}, 1_000);
});
