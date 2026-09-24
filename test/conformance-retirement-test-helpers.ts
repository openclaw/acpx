import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { observeProcessIncarnation, parseProcessBirthIdentity } from "../src/process-identity.js";
import type { Ready, Receipt } from "./fixtures/conformance-retirement.js";

const exec = promisify(execFile);
export type NativeState = "matching" | "gone" | "zombie" | "unknown";

export async function until<T>(
  label: string,
  ms: number,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(20);
  }
}

export async function readReady(
  root: string,
  role: string,
  nonce: string,
): Promise<Ready | undefined> {
  let raw: Ready;
  try {
    raw = JSON.parse(await fs.readFile(path.join(root, `${role}.ready.json`), "utf8")) as Ready;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  assert.equal(raw.nonce, nonce);
  assert.ok(Number.isSafeInteger(raw.pid) && raw.pid > 1);
  const birth = parseProcessBirthIdentity(raw.birth);
  assert.ok(birth, `${role} must publish native birth identity`);
  return { ...raw, birth };
}

export async function receipts(root: string, role: string, nonce: string): Promise<Receipt[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, `${role}.ndjson`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const row = JSON.parse(line) as Receipt;
      assert.equal(row.nonce, nonce);
      assert.equal(row.role, role);
      return row;
    });
}

export async function nativeState(owned: Ready): Promise<NativeState> {
  const state = await observeProcessIncarnation(owned.pid, owned.birth, 1_000);
  if (state === "gone" || process.platform === "win32") {
    return state;
  }
  try {
    const { stdout } = await exec("ps", ["-p", String(owned.pid), "-o", "stat="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    return stdout.trim().startsWith("Z") ? "zombie" : stdout.trim() ? state : "unknown";
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      return "gone";
    }
    throw error;
  }
}

export function stopped(state: NativeState): boolean {
  return state === "gone" || state === "zombie";
}

export async function rescue(owned: Ready): Promise<void> {
  if (stopped(await nativeState(owned))) {
    return;
  }
  // Repeat the identity check immediately before signalling. Never authorize by saved PID alone.
  assert.equal(
    await observeProcessIncarnation(owned.pid, owned.birth, 1_000),
    "matching",
    "unsafe fixture rescue: identity unknown or changed",
  );
  try {
    process.kill(owned.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  await until("identity-checked fixture retirement", 3_000, async () =>
    stopped(await nativeState(owned)) ? true : undefined,
  );
}
