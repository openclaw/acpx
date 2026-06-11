import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z, ZodError } from "zod";
import { AcpxOperationalError } from "../errors.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import { defaultSessionEventLog, sessionEventActivePath } from "./event-log.js";
import {
  findSession,
  listSessions,
  parseSessionRecord,
  writeSessionRecord,
} from "./persistence.js";

const SUPPORTED_FORMAT_VERSION = 1;

const exportedSessionSchema = z.object({
  format_version: z.literal(SUPPORTED_FORMAT_VERSION),
  exported_at: z.string(),
  exported_by: z.string(),
  session: z.object({
    record_id: z.string(),
    name: z.string().nullable(),
    agent: z.string(),
    agent_name: z.string().optional(),
    cwd_relative: z.string(),
    cwd_original: z.string().optional(),
    cwd_absolute_original: z.string().optional(),
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
  expectedAgentName?: string;
  expectedAgentCommand?: string;
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

function parseArchiveJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw importError(
      `Invalid session export archive JSON: ${error instanceof Error ? error.message : String(error)}`,
      "invalid-archive",
    );
  }
}

function assertSupportedFormatVersion(parsed: unknown): void {
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (record.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw importError(
      `Unsupported session export format_version ${String(record.format_version)}; supported version is ${SUPPORTED_FORMAT_VERSION}`,
      "unsupported-format-version",
    );
  }
}

function parseArchive(raw: string): ParsedExportedSession {
  const parsed = parseArchiveJson(raw);
  assertSupportedFormatVersion(parsed);

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

function resolveImportedName(parsed: ParsedExportedSession, requestedName: string | undefined) {
  return requestedName ?? parsed.session.name ?? undefined;
}

function assertExpectedAgentCommand(
  parsed: ParsedExportedSession,
  sourceRecord: SessionRecord,
  options: Pick<ImportSessionOptions, "expectedAgentName" | "expectedAgentCommand">,
): void {
  const expectedAgentCommand = options.expectedAgentCommand;
  if (!expectedAgentCommand) {
    return;
  }
  const expectedAgentName = normalizeAgentIdentity(options.expectedAgentName);
  const archiveAgentName = normalizeAgentIdentity(parsed.session.agent_name);
  const archiveCommandMatches = agentCommandMatchesExpected(
    parsed.session.agent,
    expectedAgentCommand,
    expectedAgentName,
  );
  const stateCommandMatches = agentCommandMatchesExpected(
    sourceRecord.agentCommand,
    expectedAgentCommand,
    expectedAgentName,
  );

  if (
    archiveCommandMatches &&
    stateCommandMatches &&
    archiveAgentNameMatches({
      archiveAgentName,
      expectedAgentName,
      archiveCommand: parsed.session.agent,
      stateCommand: sourceRecord.agentCommand,
      expectedAgentCommand,
    })
  ) {
    sourceRecord.agentCommand = expectedAgentCommand;
    return;
  }
  throw importError(
    "Session export archive agent does not match the requested agent",
    "agent-mismatch",
  );
}

function archiveAgentNameMatches(params: {
  archiveAgentName: string | undefined;
  expectedAgentName: string | undefined;
  archiveCommand: string;
  stateCommand: string;
  expectedAgentCommand: string;
}): boolean {
  if (
    params.archiveCommand === params.expectedAgentCommand &&
    params.stateCommand === params.expectedAgentCommand
  ) {
    return true;
  }
  return (
    params.archiveAgentName == null ||
    params.expectedAgentName == null ||
    params.archiveAgentName === params.expectedAgentName
  );
}

function normalizeAgentIdentity(agentName: string | undefined): string | undefined {
  const normalized = agentName?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return undefined;
  }
  return normalized === "factory-droid" || normalized === "factorydroid" ? "droid" : normalized;
}

function agentCommandMatchesExpected(
  archivedCommand: string,
  expectedAgentCommand: string,
  expectedAgentName: string | undefined,
): boolean {
  if (archivedCommand === expectedAgentCommand) {
    return true;
  }
  return expectedAgentName
    ? commandLooksLikeBuiltInAgent(archivedCommand, expectedAgentName)
    : false;
}

function commandLooksLikeBuiltInAgent(command: string, agentName: string): boolean {
  const normalized = command.trim();
  switch (agentName) {
    case "pi":
      return /(?:^|\s)pi-acp(?:@|\s|$)/.test(normalized);
    case "codex":
      return /(?:^|\s)@agentclientprotocol\/codex-acp(?:@|\s|$)/.test(normalized);
    case "claude":
      return /(?:^|\s)@agentclientprotocol\/claude-agent-acp(?:@|\s|$)/.test(normalized);
    default:
      return false;
  }
}

async function assertDestinationScopeAvailable(record: SessionRecord): Promise<void> {
  const existing = await findSession({
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
  });
  if (!existing) {
    return;
  }
  throw importError(
    "A session already exists for the import destination scope; pass --name or --cwd to import a separate copy",
    "session-scope-exists",
  );
}

async function assertProviderSessionAvailable(record: SessionRecord): Promise<void> {
  const existing = (await listSessions()).find(
    (session) => session.acpSessionId === record.acpSessionId,
  );
  if (!existing) {
    return;
  }
  throw importError(
    "A local session already uses this provider session id; prune or remove the existing record before importing this archive",
    "session-provider-exists",
  );
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
    name: resolveImportedName(parsed, options.name),
    closed: false,
    closedAt: undefined,
    pid: undefined,
    agentStartedAt: undefined,
    lastAgentExitCode: undefined,
    lastAgentExitSignal: undefined,
    lastAgentExitAt: undefined,
    lastAgentDisconnectReason: undefined,
    eventLog,
    importedFrom: {
      recordId: parsed.session.record_id,
      cwdOriginal: parsed.session.cwd_original ?? parsed.session.cwd_relative,
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
  assertExpectedAgentCommand(parsed, sourceRecord, options);

  const sessionsDir = path.join(os.homedir(), ".acpx", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const cwd = resolveImportedCwd(parsed.session.cwd_relative, options.newCwd);
  const newRecordId = await generateRecordId(sessionsDir);
  const newRecord = buildImportedRecord(parsed, sourceRecord, {
    newRecordId,
    cwd,
    name: options.name,
  });

  await assertDestinationScopeAvailable(newRecord);
  await assertProviderSessionAvailable(newRecord);
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
