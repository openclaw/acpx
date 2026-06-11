import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { AcpxOperationalError } from "../errors.js";
import { isProcessAlive } from "../process-liveness.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import {
  sessionEventActivePath,
  sessionEventLockPath,
  sessionEventSegmentPath,
} from "./event-log.js";
import { findSession, listSessions, normalizeName } from "./persistence.js";
import { serializeSessionRecordForDisk } from "./persistence/serialize.js";

export type ExportedSession = {
  format_version: 1;
  exported_at: string;
  exported_by: string;
  session: {
    record_id: string;
    name: string | null;
    agent: string;
    agent_name?: string;
    cwd_relative: string;
    cwd_original: string;
    created_at: string;
    updated_at: string;
    state: Record<string, unknown>;
  };
  history: AcpJsonRpcMessage[];
};

export type SessionExportLookup = {
  agentName?: string;
  agentCommand?: string;
  cwd?: string;
  name?: string;
};

class SessionExportError extends AcpxOperationalError {
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

function sessionLookupError(message: string, code: string): SessionExportError {
  return new SessionExportError(message, code);
}

async function loadSessionRecord(
  sessionLookup: SessionExportLookup,
): Promise<SessionRecord | undefined> {
  const cwd = path.resolve(sessionLookup.cwd ?? process.cwd());
  const name = normalizeName(sessionLookup.name);

  if (sessionLookup.agentCommand) {
    const active = await findSession({
      agentCommand: sessionLookup.agentCommand,
      cwd,
      name,
    });
    if (active) {
      return active;
    }

    return (await listSessions()).find((session) => {
      if (session.agentCommand !== sessionLookup.agentCommand || session.cwd !== cwd) {
        return false;
      }
      if (name == null) {
        return session.name == null;
      }
      return session.name === name;
    });
  }

  const matches = (await listSessions()).filter((session) => {
    if (session.cwd !== cwd) {
      return false;
    }
    if (name == null) {
      return session.name == null;
    }
    return session.name === name;
  });

  if (matches.length > 1) {
    throw sessionLookupError("multiple sessions match export lookup", "ambiguous-session");
  }

  return matches[0];
}

type EventLockPayload = {
  pid?: number;
};

function parseEventLockPayload(raw: string): EventLockPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      pid: typeof record.pid === "number" ? record.pid : undefined,
    };
  } catch {
    return {};
  }
}

async function hasLiveEventLock(recordId: string): Promise<boolean> {
  try {
    const payload = await fs.readFile(sessionEventLockPath(recordId), "utf8");
    return isProcessAlive(parseEventLockPayload(payload).pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isSessionActive(record: SessionRecord): Promise<boolean> {
  if (record.closed) {
    return false;
  }
  return isProcessAlive(record.pid) || (await hasLiveEventLock(record.acpxRecordId));
}

async function readHistoryFile(filePath: string): Promise<AcpJsonRpcMessage[]> {
  const payload = await fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const history: AcpJsonRpcMessage[] = [];
  for (const line of payload.split("\n").filter((entry) => entry.trim().length > 0)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isAcpJsonRpcMessage(parsed)) {
        history.push(parsed);
      }
    } catch {
      // Match event listing resilience: tolerate truncated NDJSON writes.
    }
  }
  return history;
}

async function readSessionHistory(record: SessionRecord): Promise<AcpJsonRpcMessage[]> {
  const history: AcpJsonRpcMessage[] = [];
  const maxSegments = Number.isInteger(record.eventLog.max_segments)
    ? record.eventLog.max_segments
    : 0;

  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    history.push(...(await readHistoryFile(sessionEventSegmentPath(record.acpxRecordId, segment))));
  }

  history.push(...(await readHistoryFile(sessionEventActivePath(record.acpxRecordId))));
  return history;
}

function cwdRelativeToHome(cwd: string, home: string): string {
  const relative = path.relative(home, cwd);
  if (relative.length === 0) {
    return ".";
  }
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return cwd;
}

function serializeSessionRecordForArchive(
  record: SessionRecord,
  cwdRelative: string,
): Record<string, unknown> {
  const state = serializeSessionRecordForDisk(record);
  state.cwd = cwdRelative;

  if (state.event_log && typeof state.event_log === "object" && !Array.isArray(state.event_log)) {
    state.event_log = {
      ...(state.event_log as Record<string, unknown>),
      active_path: ".stream.ndjson",
    };
  }

  return state;
}

export async function exportSession(
  sessionLookup: SessionExportLookup,
  outputPath: string,
): Promise<void> {
  const record = await loadSessionRecord(sessionLookup);
  if (!record) {
    throw sessionLookupError("session not found", "not-found");
  }

  if (await isSessionActive(record)) {
    throw sessionLookupError(
      "session is currently locked by a running queue owner; close it first with `acpx sessions close`",
      "session-locked",
    );
  }

  const home = os.homedir();
  const cwdRelative = cwdRelativeToHome(record.cwd, home);
  const exported: ExportedSession = {
    format_version: 1,
    exported_at: new Date().toISOString(),
    exported_by: "acpx",
    session: {
      record_id: record.acpxRecordId,
      name: record.name ?? null,
      agent: record.agentCommand,
      agent_name: normalizeAgentName(sessionLookup.agentName),
      cwd_relative: cwdRelative,
      cwd_original: cwdRelative,
      created_at: record.createdAt,
      updated_at: record.lastUsedAt,
      state: serializeSessionRecordForArchive(record, cwdRelative),
    },
    history: await readSessionHistory(record),
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(exported, null, 2)}\n`, "utf8");
}

function normalizeAgentName(agentName: string | undefined): string | undefined {
  const normalized = agentName?.trim().toLowerCase();
  if (!normalized || normalized.length === 0) {
    return undefined;
  }
  return normalized === "factory-droid" || normalized === "factorydroid" ? "droid" : normalized;
}
