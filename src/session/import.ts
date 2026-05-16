import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z, ZodError } from "zod";
import { AcpxOperationalError } from "../errors.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import { defaultSessionEventLog, sessionEventActivePath } from "./event-log.js";
import { parseSessionRecord, writeSessionRecord } from "./persistence.js";

const SUPPORTED_FORMAT_VERSION = 1;

const exportedSessionSchema = z.object({
  format_version: z.literal(SUPPORTED_FORMAT_VERSION),
  exported_at: z.string(),
  exported_by: z.string(),
  session: z.object({
    record_id: z.string(),
    name: z.string().nullable(),
    agent: z.string(),
    cwd_relative: z.string(),
    cwd_absolute_original: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    state: z.unknown(),
  }),
  history: z.array(z.unknown()),
});

type ParsedExportedSession = z.infer<typeof exportedSessionSchema>;

export type ImportSessionOptions = {
  name?: string;
  newCwd?: string;
};

class SessionImportError extends AcpxOperationalError {
  readonly code: string;
  readonly exitCode = 2;

  constructor(message: string, code: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: code,
      origin: "cli",
    });
    this.code = code;
  }
}

function importError(message: string, code: string): SessionImportError {
  return new SessionImportError(message, code);
}

function parseArchive(raw: string): ParsedExportedSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw importError(
      `Invalid session export archive JSON: ${error instanceof Error ? error.message : String(error)}`,
      "invalid-archive",
    );
  }

  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (record.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw importError(
      `Unsupported session export format_version ${String(record.format_version)}; supported version is ${SUPPORTED_FORMAT_VERSION}`,
      "unsupported-format-version",
    );
  }

  try {
    return exportedSessionSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw importError(
        `Invalid session export archive: ${error.issues[0]?.message}`,
        "invalid-archive",
      );
    }
    throw error;
  }
}

async function generateRecordId(sessionsDir: string): Promise<string> {
  for (;;) {
    const recordId = randomUUID();
    const filePath = path.join(sessionsDir, `${encodeURIComponent(recordId)}.json`);
    try {
      await fs.access(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return recordId;
      }
      throw error;
    }
  }
}

function resolveImportedCwd(cwdRelative: string, newCwd: string | undefined): string {
  if (newCwd) {
    return path.resolve(newCwd);
  }
  if (path.isAbsolute(cwdRelative)) {
    return cwdRelative;
  }
  return path.join(os.homedir(), cwdRelative);
}

function buildImportedRecord(
  parsed: ParsedExportedSession,
  sourceRecord: SessionRecord,
  options: { newRecordId: string; cwd: string; name?: string },
): SessionRecord {
  const eventLog = {
    ...defaultSessionEventLog(options.newRecordId),
    max_segment_bytes: sourceRecord.eventLog.max_segment_bytes,
    max_segments: sourceRecord.eventLog.max_segments,
    segment_count: parsed.history.length > 0 ? 1 : sourceRecord.eventLog.segment_count,
  };

  return {
    ...sourceRecord,
    acpxRecordId: options.newRecordId,
    cwd: options.cwd,
    name: options.name ?? parsed.session.name ?? undefined,
    eventLog,
    importedFrom: {
      recordId: parsed.session.record_id,
      cwdOriginal: parsed.session.cwd_absolute_original,
      exportedBy: parsed.exported_by,
      exportedAt: parsed.exported_at,
    },
  };
}

export async function importSession(
  archivePath: string,
  options: ImportSessionOptions = {},
): Promise<{ record_id: string; cwd: string }> {
  const parsed = parseArchive(await fs.readFile(archivePath, "utf8"));
  const sourceRecord = parseSessionRecord(parsed.session.state);
  if (!sourceRecord) {
    throw importError(
      "Invalid session export archive: session.state is not a session record",
      "invalid-archive",
    );
  }

  const sessionsDir = path.join(os.homedir(), ".acpx", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const cwd = resolveImportedCwd(parsed.session.cwd_relative, options.newCwd);
  const newRecordId = await generateRecordId(sessionsDir);
  const newRecord = buildImportedRecord(parsed, sourceRecord, {
    newRecordId,
    cwd,
    name: options.name,
  });

  await writeSessionRecord(newRecord);

  if (parsed.history.length > 0) {
    const history = parsed.history as AcpJsonRpcMessage[];
    await fs.writeFile(
      sessionEventActivePath(newRecordId),
      `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }

  return { record_id: newRecordId, cwd };
}
