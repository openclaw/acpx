import { Command } from "commander";
import { findSession } from "../session/persistence.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  addSessionNameOption,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveSessionNameFromFlags,
  type StatusFlags,
} from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
import { agentSessionIdPayload } from "./output/render.js";
import { probeQueueOwnerHealth } from "./queue/ipc.js";

function formatUptime(startedAt: string | undefined): string | undefined {
  if (!startedAt) {
    return undefined;
  }

  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return undefined;
  }

  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const seconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${remSeconds.toString().padStart(2, "0")}`;
}

export async function handleStatus(
  explicitAgentName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: resolveSessionNameFromFlags(flags, command),
  });

  if (!record) {
    if (
      emitJsonResult(globalFlags.format, {
        action: "status_snapshot",
        status: "no-session",
        summary: "no active session",
      })
    ) {
      return;
    }

    if (globalFlags.format === "quiet") {
      process.stdout.write("no-session\n");
      return;
    }

    process.stdout.write("session: -\n");
    process.stdout.write(`agent: ${agent.agentCommand}\n`);
    process.stdout.write("pid: -\n");
    process.stdout.write("status: no-session\n");
    process.stdout.write("model: -\n");
    process.stdout.write("mode: -\n");
    process.stdout.write("uptime: -\n");
    process.stdout.write("lastPromptTime: -\n");
    return;
  }

  const health = await probeQueueOwnerHealth(record.acpxRecordId);
  const running = health.healthy;
  const payload = {
    sessionId: record.acpxRecordId,
    agentCommand: record.agentCommand,
    pid: health.pid ?? record.pid ?? null,
    status: running ? "running" : "dead",
    model: record.acpx?.current_model_id ?? null,
    mode: record.acpx?.current_mode_id ?? null,
    availableModels: record.acpx?.available_models ?? null,
    uptime: running ? (formatUptime(record.agentStartedAt) ?? null) : null,
    lastPromptTime: record.lastPromptAt ?? null,
    exitCode: running ? null : (record.lastAgentExitCode ?? null),
    signal: running ? null : (record.lastAgentExitSignal ?? null),
    ...agentSessionIdPayload(record.agentSessionId),
  };

  if (
    emitJsonResult(globalFlags.format, {
      action: "status_snapshot",
      status: running ? "alive" : "dead",
      pid: payload.pid ?? undefined,
      summary: running ? "queue owner healthy" : "queue owner unavailable",
      model: payload.model ?? undefined,
      mode: payload.mode ?? undefined,
      availableModels: payload.availableModels ?? undefined,
      uptime: payload.uptime ?? undefined,
      lastPromptTime: payload.lastPromptTime ?? undefined,
      exitCode: payload.exitCode ?? undefined,
      signal: payload.signal ?? undefined,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    })
  ) {
    return;
  }

  if (globalFlags.format === "quiet") {
    process.stdout.write(`${payload.status}\n`);
    return;
  }

  process.stdout.write(`session: ${payload.sessionId}\n`);
  if ("agentSessionId" in payload) {
    process.stdout.write(`agentSessionId: ${payload.agentSessionId}\n`);
  }
  process.stdout.write(`agent: ${payload.agentCommand}\n`);
  process.stdout.write(`pid: ${payload.pid ?? "-"}\n`);
  process.stdout.write(`status: ${payload.status}\n`);
  process.stdout.write(`model: ${payload.model ?? "-"}\n`);
  process.stdout.write(`mode: ${payload.mode ?? "-"}\n`);
  process.stdout.write(`uptime: ${payload.uptime ?? "-"}\n`);
  process.stdout.write(`lastPromptTime: ${payload.lastPromptTime ?? "-"}\n`);
  if (payload.status === "dead") {
    process.stdout.write(`exitCode: ${payload.exitCode ?? "-"}\n`);
    process.stdout.write(`signal: ${payload.signal ?? "-"}\n`);
  }
}

export function registerStatusCommand(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
  description: string,
): void {
  const statusCommand = parent.command("status").description(description);
  addSessionNameOption(statusCommand);
  statusCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleStatus(explicitAgentName, flags, this, config);
  });
}
