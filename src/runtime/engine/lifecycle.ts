import { normalizeAgentSessionId } from "../../acp/agent-session-id.js";
import type { AgentLifecycleSnapshot } from "../../acp/client.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import type { SessionConversation, SessionRecord } from "../../types.js";

export function createInitialSessionRecord(params: {
  recordId: string;
  name?: string;
  sessionId: string;
  agentCommand: string;
  agentArgv?: string[];
  cwd: string;
  agentSessionId?: string;
}): SessionRecord {
  const now = new Date().toISOString();
  return {
    schema: "acpx.session.v1",
    acpxRecordId: params.recordId,
    acpSessionId: params.sessionId,
    agentSessionId: params.agentSessionId,
    agentCommand: params.agentCommand,
    agentArgv: params.agentArgv,
    cwd: params.cwd,
    name: params.name,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: defaultSessionEventLog(params.recordId),
    closed: false,
    closedAt: undefined,
    ...createSessionConversation(now),
    acpx: {},
  };
}

export function applyLifecycleSnapshotToRecord(
  record: SessionRecord,
  snapshot: AgentLifecycleSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }

  record.pid = snapshot.running ? snapshot.pid : undefined;
  record.agentStartedAt = snapshot.startedAt;

  if (snapshot.lastExit) {
    record.lastAgentExitCode = snapshot.lastExit.exitCode;
    record.lastAgentExitSignal = snapshot.lastExit.signal;
    record.lastAgentExitAt = snapshot.lastExit.exitedAt;
    record.lastAgentDisconnectReason = snapshot.lastExit.reason;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
}

export function reconcileAgentSessionId(
  record: SessionRecord,
  agentSessionId: string | undefined,
): void {
  const normalized = normalizeAgentSessionId(agentSessionId);
  if (!normalized) {
    return;
  }

  record.agentSessionId = normalized;
}

export function sessionHasAgentMessages(
  recordOrConversation: Pick<SessionRecord, "messages"> | SessionConversation,
): boolean {
  return recordOrConversation.messages.some(
    (message) => typeof message === "object" && message !== null && "Agent" in message,
  );
}

export function applyConversation(record: SessionRecord, conversation: SessionConversation): void {
  record.title = conversation.title;
  record.updated_at = conversation.updated_at;
  record.messages = conversation.messages;
  record.cumulative_token_usage = conversation.cumulative_token_usage;
  record.cumulative_cost = conversation.cumulative_cost;
  record.request_token_usage = conversation.request_token_usage;
}
