/**
 * Verifies that spawning with detached:true and killing via process.kill(-pgid)
 * terminates the entire process group, including grandchild processes.
 *
 * This test demonstrates the fix for orphan kiro-cli-chat processes:
 * - WITHOUT the fix: only the parent (kiro-cli wrapper) is killed; child survives
 * - WITH the fix: entire process group is killed; no orphans
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("process group kill terminates parent and grandchild (no orphan)", async () => {
  // Spawn a parent shell that forks a grandchild (simulates kiro-cli → kiro-cli-chat)
  // Parent prints its PID, then forks a long-running grandchild, then sleeps.
  const parent = spawn(
    "bash",
    [
      "-c",
      // Print parent pid, fork grandchild sleep, wait
      'echo "PARENT=$$"; sleep 60 & echo "CHILD=$!"; wait',
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  // Collect stdout to get parent and child PIDs
  let output = "";
  parent.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  // Wait until both PIDs are printed
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (output.includes("PARENT=") && output.includes("CHILD=")) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });

  const parentPid = parseInt(output.match(/PARENT=(\d+)/)![1]);
  const childPid = parseInt(output.match(/CHILD=(\d+)/)![1]);

  assert.ok(isRunning(parentPid), "parent should be running before kill");
  assert.ok(isRunning(childPid), "grandchild should be running before kill");

  // Kill entire process group (the fix)
  assert.ok(parent.pid != null);
  process.kill(-parent.pid, "SIGTERM");

  // Give processes time to terminate
  await sleep(200);

  assert.ok(!isRunning(parentPid), "parent should be dead after process group kill");
  assert.ok(
    !isRunning(childPid),
    "grandchild should be dead after process group kill (no orphan)",
  );
});

test("killing only parent pid leaves grandchild as orphan (demonstrates the bug)", async () => {
  const parent = spawn(
    "bash",
    ["-c", 'echo "PARENT=$$"; sleep 60 & echo "CHILD=$!"; wait'],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  let output = "";
  parent.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (output.includes("PARENT=") && output.includes("CHILD=")) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });

  const parentPid = parseInt(output.match(/PARENT=(\d+)/)![1]);
  const childPid = parseInt(output.match(/CHILD=(\d+)/)![1]);

  // Kill only the parent (old behavior — no process group kill)
  process.kill(parentPid, "SIGTERM");

  await sleep(200);

  assert.ok(!isRunning(parentPid), "parent should be dead");
  // Grandchild survives as orphan — this is the bug the fix addresses
  assert.ok(
    isRunning(childPid),
    "grandchild survives as orphan without process group kill",
  );

  // Cleanup orphan
  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    // already gone
  }
});
