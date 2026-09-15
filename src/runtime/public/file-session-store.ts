import fs from "node:fs/promises";
import path from "node:path";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import { parseSessionRecord } from "../../session/persistence/parse.js";
import { serializeSessionRecordForDisk } from "../../session/persistence/serialize.js";
import { writePrivateJsonFile } from "../../state-files.js";
import type { AcpFileSessionStoreOptions, AcpSessionRecord, AcpSessionStore } from "./contract.js";

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

class FileSessionStore implements AcpSessionStore {
  constructor(private readonly stateDir: string) {}

  private get sessionDir(): string {
    return path.join(this.stateDir, "sessions");
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionDir, `${safeSessionId(sessionId)}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  async load(sessionId: string): Promise<AcpSessionRecord | undefined> {
    await this.ensureDir();
    let payload: string;
    try {
      payload = await fs.readFile(this.filePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return undefined;
    }
    return parseSessionRecord(parsed) ?? undefined;
  }

  async save(record: AcpSessionRecord): Promise<void> {
    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    await writePrivateJsonFile(this.filePath(record.acpxRecordId), persisted);
  }
}

export function createFileSessionStore(options: AcpFileSessionStoreOptions): AcpSessionStore {
  return new FileSessionStore(path.resolve(options.stateDir));
}
