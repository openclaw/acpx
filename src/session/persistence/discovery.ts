import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../../types.js";
import { safeSessionId } from "../event-log.js";
import { parseSessionRecord } from "./parse.js";

const DISCOVERY_BATCH_SIZE = 4;

/** Select and return the same canonical snapshot; cached metadata cannot exclude records. */
export async function* scanSessionRecords(sessionDir: string): AsyncGenerator<SessionRecord> {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();
  for (let offset = 0; offset < files.length; offset += DISCOVERY_BATCH_SIZE) {
    const records = await Promise.all(
      files
        .slice(offset, offset + DISCOVERY_BATCH_SIZE)
        .map((file) => readRecord(path.join(sessionDir, file))),
    );
    for (const record of records) {
      if (record) {
        yield record;
      }
    }
  }
}

async function readRecord(file: string): Promise<SessionRecord | undefined> {
  try {
    const payload = await fs.readFile(file, "utf8");
    const record = parseSessionRecord(JSON.parse(payload));
    return record && path.basename(file) === `${safeSessionId(record.acpxRecordId)}.json`
      ? record
      : undefined;
  } catch {
    // A corrupt or concurrently removed record must not hide other matches.
    return undefined;
  }
}
