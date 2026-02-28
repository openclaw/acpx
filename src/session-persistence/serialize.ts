import { normalizeRuntimeSessionId } from "../runtime-session-id.js";
import type { SessionRecord } from "../types.js";
import { SESSION_RECORD_SCHEMA } from "../types.js";

export function serializeSessionRecordForDisk(
  record: SessionRecord,
): Record<string, unknown> {
  const canonical: SessionRecord = {
    ...record,
    schema: SESSION_RECORD_SCHEMA,
  };

  return {
    schema: canonical.schema,
    acpx_record_id: canonical.acpxRecordId,
    acp_session_id: canonical.acpSessionId,
    agent_session_id: normalizeRuntimeSessionId(canonical.agentSessionId),
    agent_command: canonical.agentCommand,
    cwd: canonical.cwd,
    name: canonical.name,
    created_at: canonical.createdAt,
    last_used_at: canonical.lastUsedAt,
    last_seq: canonical.lastSeq,
    last_request_id: canonical.lastRequestId,
    event_log: canonical.eventLog,
    closed: canonical.closed,
    closed_at: canonical.closedAt,
    pid: canonical.pid,
    agent_started_at: canonical.agentStartedAt,
    last_prompt_at: canonical.lastPromptAt,
    last_agent_exit_code: canonical.lastAgentExitCode,
    last_agent_exit_signal: canonical.lastAgentExitSignal,
    last_agent_exit_at: canonical.lastAgentExitAt,
    last_agent_disconnect_reason: canonical.lastAgentDisconnectReason,
    protocol_version: canonical.protocolVersion,
    agent_capabilities: canonical.agentCapabilities,
    title: canonical.title,
    messages: canonical.messages,
    updated_at: canonical.updated_at,
    cumulative_token_usage: canonical.cumulative_token_usage,
    request_token_usage: canonical.request_token_usage,
    acpx: canonical.acpx,
  };
}
