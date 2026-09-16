import { normalizeAgentSessionId } from "../../acp/agent-session-id.js";
import type { SessionRecord } from "../../types.js";
import { SESSION_RECORD_SCHEMA } from "../../types.js";

export function serializeSessionRecordForDisk(record: SessionRecord): Record<string, unknown> {
  return {
    schema: SESSION_RECORD_SCHEMA,
    acpx_record_id: record.acpxRecordId,
    acp_session_id: record.acpSessionId,
    agent_session_id: normalizeAgentSessionId(record.agentSessionId),
    agent_command: record.agentCommand,
    agent_argv: record.agentArgv,
    cwd: record.cwd,
    name: record.name,
    created_at: record.createdAt,
    last_used_at: record.lastUsedAt,
    last_seq: record.lastSeq,
    last_request_id: record.lastRequestId,
    event_log: record.eventLog,
    closed: record.closed,
    closed_at: record.closedAt,
    pid: record.pid,
    agent_started_at: record.agentStartedAt,
    last_prompt_at: record.lastPromptAt,
    last_agent_exit_code: record.lastAgentExitCode,
    last_agent_exit_signal: record.lastAgentExitSignal,
    last_agent_exit_at: record.lastAgentExitAt,
    last_agent_disconnect_reason: record.lastAgentDisconnectReason,
    protocol_version: record.protocolVersion,
    agent_capabilities: record.agentCapabilities,
    title: record.title,
    messages: record.messages,
    updated_at: record.updated_at,
    cumulative_token_usage: record.cumulative_token_usage,
    cumulative_cost: record.cumulative_cost,
    request_token_usage: record.request_token_usage,
    acpx: record.acpx,
    imported_from: record.importedFrom
      ? {
          record_id: record.importedFrom.recordId,
          cwd_original: record.importedFrom.cwdOriginal,
          exported_by: record.importedFrom.exportedBy,
          exported_at: record.importedFrom.exportedAt,
        }
      : undefined,
  };
}
