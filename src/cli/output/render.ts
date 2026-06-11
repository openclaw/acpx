import path from "node:path";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { AgentSessionListResult, OutputFormat, SessionRecord } from "../../types.js";
import { probeQueueOwnerHealth } from "../queue/ipc.js";
import { emitJsonResult } from "./json-output.js";

function formatSessionLabel(record: SessionRecord): string {
  return record.name ?? "cwd";
}

function formatRoutedFrom(sessionCwd: string, currentCwd: string): string | undefined {
  const relative = path.relative(sessionCwd, currentCwd);
  if (!relative || relative === ".") {
    return undefined;
  }
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`;
}

type SessionConnectionStatus = "connected" | "needs reconnect";

async function resolveSessionConnectionStatus(
  record: SessionRecord,
): Promise<SessionConnectionStatus> {
  const health = await probeQueueOwnerHealth(record.acpxRecordId);
  return health.healthy ? "connected" : "needs reconnect";
}

export function printSessionsByFormat(sessions: SessionRecord[], format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }

  if (format === "quiet") {
    printQuietSessions(sessions);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No sessions\n");
    return;
  }

  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(
      `${session.acpxRecordId}${closedMarker}\t${session.name ?? "-"}\t${session.cwd}\t${session.lastUsedAt}\n`,
    );
  }
}

function printQuietSessions(sessions: SessionRecord[]): void {
  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(`${session.acpxRecordId}${closedMarker}\n`);
  }
}

export function printAgentSessionsByFormat(
  result: AgentSessionListResult,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (format === "quiet") {
    printQuietAgentSessions(result);
    return;
  }

  printTextAgentSessions(result);
}

function printQuietAgentSessions(result: AgentSessionListResult): void {
  for (const session of result.sessions) {
    process.stdout.write(`${session.sessionId}\n`);
  }
}

function printTextAgentSessions(result: AgentSessionListResult): void {
  if (result.sessions.length === 0) {
    process.stdout.write("No sessions\n");
  } else {
    for (const session of result.sessions) {
      const title = session.title ?? "-";
      const updatedAt = session.updatedAt ?? "-";
      const meta = session._meta ? JSON.stringify(session._meta) : "-";
      process.stdout.write(
        `${session.sessionId}\t${title}\t${session.cwd}\t${updatedAt}\t${meta}\n`,
      );
    }
  }

  if (result.nextCursor) {
    process.stdout.write(`Next cursor: ${result.nextCursor}\n`);
  }
}

export function printClosedSessionByFormat(record: SessionRecord, format: OutputFormat): void {
  if (
    emitJsonResult(format, {
      action: "session_closed",
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

export function printNewSessionByFormat(
  record: SessionRecord,
  replaced: SessionRecord | undefined,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created: true,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
      replacedSessionId: replaced?.acpxRecordId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  if (replaced) {
    process.stdout.write(`${record.acpxRecordId}\t(replaced ${replaced.acpxRecordId})\n`);
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

export function printEnsuredSessionByFormat(
  record: SessionRecord,
  created: boolean,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  const action = created ? "created" : "existing";
  process.stdout.write(`${record.acpxRecordId}\t(${action})\n`);
}

export function printQueuedPromptByFormat(
  result: {
    sessionId: string;
    requestId: string;
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "prompt_queued",
      acpxRecordId: result.sessionId,
      requestId: result.requestId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`[queued] ${result.requestId}\n`);
}

export function formatPromptSessionBannerLine(
  record: SessionRecord,
  currentCwd: string,
  connectionStatus: SessionConnectionStatus = "needs reconnect",
): string {
  const label = formatSessionLabel(record);
  const normalizedSessionCwd = path.resolve(record.cwd);
  const normalizedCurrentCwd = path.resolve(currentCwd);
  const routedFrom =
    normalizedSessionCwd === normalizedCurrentCwd
      ? undefined
      : formatRoutedFrom(normalizedSessionCwd, normalizedCurrentCwd);
  const status = connectionStatus;

  if (routedFrom) {
    return `[acpx] session ${label} (${record.acpxRecordId}) · ${normalizedSessionCwd} (routed from ${routedFrom}) · agent ${status}`;
  }

  return `[acpx] session ${label} (${record.acpxRecordId}) · ${normalizedSessionCwd} · agent ${status}`;
}

export async function printPromptSessionBanner(
  record: SessionRecord,
  currentCwd: string,
  format: OutputFormat,
  jsonStrict = false,
): Promise<void> {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const status = await resolveSessionConnectionStatus(record);
  process.stderr.write(`${formatPromptSessionBannerLine(record, currentCwd, status)}\n`);
}

export function printCreatedSessionBanner(
  record: SessionRecord,
  agentName: string,
  format: OutputFormat,
  jsonStrict = false,
): void {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const label = formatSessionLabel(record);
  process.stderr.write(`[acpx] created session ${label} (${record.acpxRecordId})\n`);
  process.stderr.write(`[acpx] agent: ${agentName}\n`);
  process.stderr.write(`[acpx] cwd: ${record.cwd}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function printPruneResultByFormat(
  result: { pruned: SessionRecord[]; bytesFreed: number; dryRun: boolean },
  format: OutputFormat,
): void {
  const count = result.pruned.length;

  if (emitPruneJsonResult(result, format, count)) {
    return;
  }

  if (format === "quiet") {
    printQuietPruneResult(result.pruned);
    return;
  }

  if (count === 0) {
    process.stdout.write(
      result.dryRun ? "[DRY RUN] No sessions to prune\n" : "No sessions pruned\n",
    );
    return;
  }

  process.stdout.write(`${formatPruneSummaryLine(result, count)}\n`);

  for (const record of result.pruned) {
    const label = record.name ? ` (${record.name})` : "";
    process.stdout.write(
      `  ${record.acpxRecordId}${label}\t${record.closedAt ?? record.lastUsedAt}\n`,
    );
  }
}

function emitPruneJsonResult(
  result: { pruned: SessionRecord[]; bytesFreed: number; dryRun: boolean },
  format: OutputFormat,
  count: number,
): boolean {
  return emitJsonResult(format, {
    action: result.dryRun ? "sessions_prune_dry_run" : "sessions_pruned",
    dryRun: result.dryRun,
    count,
    bytesFreed: result.bytesFreed,
    pruned: result.pruned.map((r) => r.acpxRecordId),
  });
}

function printQuietPruneResult(pruned: SessionRecord[]): void {
  for (const record of pruned) {
    process.stdout.write(`${record.acpxRecordId}\n`);
  }
}

function formatPruneSummaryLine(
  result: { bytesFreed: number; dryRun: boolean },
  count: number,
): string {
  const prefix = result.dryRun ? "[DRY RUN] Would prune" : "Pruned";
  const bytesSuffix =
    !result.dryRun && result.bytesFreed > 0 ? `, freed ${formatBytes(result.bytesFreed)}` : "";
  return `${prefix} ${count} session${count === 1 ? "" : "s"}${bytesSuffix}`;
}

export function agentSessionIdPayload(agentSessionId: string | undefined): {
  agentSessionId?: string;
} {
  const normalized = normalizeRuntimeSessionId(agentSessionId);
  if (!normalized) {
    return {};
  }

  return { agentSessionId: normalized };
}
