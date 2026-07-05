import fs from "node:fs/promises";
import path from "node:path";
import { resolveLifelineHelper } from "../src/acp/lifeline.js";

export const LIFELINE_HELPER_ENV = "ACPX_LIFELINE_HELPER";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTestLifelineHelper(): Promise<string | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }

  const helperName = `lifeline-${process.platform}-${process.arch}`;
  const builtHelper = path.resolve("dist", "native", helperName);
  const previous = process.env[LIFELINE_HELPER_ENV];

  try {
    if (await fileExists(builtHelper)) {
      process.env[LIFELINE_HELPER_ENV] = builtHelper;
    }
    return resolveLifelineHelper();
  } finally {
    if (previous === undefined) {
      delete process.env[LIFELINE_HELPER_ENV];
    } else {
      process.env[LIFELINE_HELPER_ENV] = previous;
    }
  }
}
