import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { assertControlAuthority, type AcpControlAuthority } from "../async-control.js";
import { PermissionDeniedError, PermissionPromptUnavailableError } from "../errors.js";
import { promptForPermission } from "../permission-prompt.js";
import {
  buildSpawnCommandOptions,
  buildTerminalShellSpawnCommand,
  buildTerminalSpawnCommand,
  type TerminalSpawnCommand,
} from "../spawn-command-options.js";
import type { ClientOperation, NonInteractivePermissionPolicy, PermissionMode } from "../types.js";
import { PROCESS_HELPER_TIMEOUT_MS, runTimedExecFile, waitForSpawn } from "./client-process.js";
import { ProcessDescendants } from "./process-descendants.js";

const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_500;

type ManagedTerminal = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  killProcessGroup: boolean;
  descendantPids: Set<number>;
  descendants?: ProcessDescendants;
  processGroupSnapshotPromise?: Promise<void>;
  processHelperTimeoutMs: number;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  exitPromise: Promise<WaitForTerminalExitResponse>;
  resolveExit: (response: WaitForTerminalExitResponse) => void;
};

export type TerminalManagerOptions = {
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  onOperation?: (operation: ClientOperation) => void;
  confirmExecute?: (commandLine: string, signal?: AbortSignal) => Promise<boolean>;
  killGraceMs?: number;
  processHelperTimeoutMs?: number;
};

type TerminalSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  stdio: ["ignore", "pipe", "pipe"];
  detached?: boolean;
  shell?: true;
  windowsHide: true;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toCommandLine(command: string, args: string[] | undefined): string {
  const renderedArgs = (args ?? []).map((arg) => JSON.stringify(arg)).join(" ");
  return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}

function toEnvObject(env: CreateTerminalRequest["env"]): NodeJS.ProcessEnv | undefined {
  if (!env || env.length === 0) {
    return undefined;
  }

  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of env) {
    merged[entry.name] = entry.value;
  }
  return merged;
}

export function buildTerminalSpawnOptions(
  command: string,
  cwd: string,
  env: CreateTerminalRequest["env"],
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnOptions {
  const resolvedEnv = toEnvObject(env);
  const options: TerminalSpawnOptions = {
    cwd,
    env: resolvedEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  return buildSpawnCommandOptions(
    command,
    options,
    platform,
    resolvedEnv ?? process.env,
  ) as TerminalSpawnOptions;
}

function readTerminalOutputCeiling(): number | undefined {
  const raw = process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES?.trim();
  if (!raw) {
    return undefined;
  }
  const bytes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(bytes)) {
    throw new Error(
      "ACPX_TERMINAL_MAX_OUTPUT_BYTES must be a non-negative safe integer; zero disables the host ceiling",
    );
  }
  return bytes === 0 ? undefined : bytes;
}

function resolveTerminalOutputLimit(
  requested: CreateTerminalRequest["outputByteLimit"],
  ceiling: number | undefined,
): number {
  return Math.min(
    Math.max(0, Math.round(requested ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES)),
    ceiling ?? Number.POSITIVE_INFINITY,
  );
}

function tracksTerminalDescendants(terminal: ManagedTerminal): boolean {
  return terminal.killProcessGroup || terminal.descendants !== undefined;
}

function createTerminalDescendants(
  proc: ManagedTerminal["process"],
  killProcessGroup: boolean,
): ProcessDescendants | undefined {
  // Windows shell launches retain their taskkill tree-cleanup path.
  return process.platform === "win32" && killProcessGroup
    ? undefined
    : new ProcessDescendants(proc, { ownProcessGroup: true });
}

function trimToUtf8Boundary(buffer: Buffer, limit: number): Buffer {
  if (limit <= 0) {
    return Buffer.alloc(0);
  }
  let start = Math.max(0, buffer.length - limit);
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }

  if (start >= buffer.length) {
    return Buffer.alloc(0);
  }
  return buffer.subarray(start);
}

async function defaultConfirmExecute(commandLine: string, signal?: AbortSignal): Promise<boolean> {
  return await promptForPermission({
    prompt: `\n[permission] Allow terminal command "${commandLine}"? (y/N) `,
    signal,
  });
}

function canPromptForPermission(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function onStreamError(): void {
  // Child pipe failures must not terminate the ACP host; process exit owns status.
}

export class TerminalManager {
  private readonly cwd: string;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissionPolicy;
  private readonly onOperation?: (operation: ClientOperation) => void;
  private readonly usesDefaultConfirmExecute: boolean;
  private readonly confirmExecute: NonNullable<TerminalManagerOptions["confirmExecute"]>;
  private readonly killGraceMs: number;
  private readonly processHelperTimeoutMs: number;
  private readonly outputCeilingBytes: number | undefined;
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(options: TerminalManagerOptions) {
    this.outputCeilingBytes = readTerminalOutputCeiling();
    this.cwd = options.cwd;
    this.permissionMode = options.permissionMode;
    this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
    this.onOperation = options.onOperation;
    this.usesDefaultConfirmExecute = options.confirmExecute == null;
    this.confirmExecute = options.confirmExecute ?? defaultConfirmExecute;
    const killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
    // Match Node's timer clamp so invalid delays cannot create an infinite deadline.
    this.killGraceMs =
      Number.isFinite(killGraceMs) && killGraceMs <= 2_147_483_647 ? killGraceMs : 1;
    this.processHelperTimeoutMs = Math.max(
      1,
      Math.round(options.processHelperTimeoutMs ?? PROCESS_HELPER_TIMEOUT_MS),
    );
  }

  updatePermissionPolicy(
    permissionMode: PermissionMode,
    nonInteractivePermissions?: NonInteractivePermissionPolicy,
  ): void {
    this.permissionMode = permissionMode;
    this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
  }

  async createTerminal(
    params: CreateTerminalRequest,
    authority?: AcpControlAuthority,
  ): Promise<CreateTerminalResponse> {
    assertControlAuthority(authority);
    const commandLine = toCommandLine(params.command, params.args);
    const summary = `terminal/create: ${commandLine}`;

    this.emitOperation({
      method: "terminal/create",
      status: "running",
      summary,
      timestamp: nowIso(),
    });

    try {
      const approved = await this.isExecuteApproved(commandLine, authority?.signal);
      assertControlAuthority(authority);
      if (!approved) {
        throw new PermissionDeniedError("Permission denied for terminal/create");
      }

      const outputByteLimit = resolveTerminalOutputLimit(
        params.outputByteLimit,
        this.outputCeilingBytes,
      );
      const { proc, spawnCommand } = await spawnTerminalProcess(params, this.cwd, authority);

      let resolveExit: (response: WaitForTerminalExitResponse) => void = () => {};
      const exitPromise = new Promise<WaitForTerminalExitResponse>((resolve) => {
        resolveExit = resolve;
      });

      const terminal: ManagedTerminal = {
        process: proc,
        killProcessGroup: spawnCommand.killProcessGroup,
        descendantPids: new Set(),
        descendants: createTerminalDescendants(proc, spawnCommand.killProcessGroup),
        processHelperTimeoutMs: this.processHelperTimeoutMs,
        output: Buffer.alloc(0),
        truncated: false,
        outputByteLimit,
        exitCode: undefined,
        signal: undefined,
        exitPromise,
        resolveExit,
      };

      const appendOutput = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.length === 0) {
          return;
        }

        terminal.output = Buffer.concat([terminal.output, bytes]);
        terminal.truncated ||= terminal.output.length > terminal.outputByteLimit;
        // Later chunks can finish a code point whose prefix was already discarded.
        if (terminal.truncated) {
          terminal.output = trimToUtf8Boundary(terminal.output, terminal.outputByteLimit);
        }
      };

      proc.stdout.on("data", appendOutput);
      proc.stderr.on("data", appendOutput);
      proc.stdout.on("error", onStreamError);
      proc.stderr.on("error", onStreamError);
      proc.once("exit", (exitCode, signal) => {
        terminal.exitCode = exitCode;
        terminal.signal = signal;
        terminal.processGroupSnapshotPromise = terminal.descendants
          ? terminal.descendants.capture(terminal.processHelperTimeoutMs).then(() => {})
          : rememberProcessGroupPids(terminal);
        void (async () => {
          await terminal.processGroupSnapshotPromise;
          terminal.processGroupSnapshotPromise = undefined;
          terminal.resolveExit({
            exitCode: exitCode ?? null,
            signal: signal ?? null,
          });
        })();
      });

      const terminalId = randomUUID();
      this.terminals.set(terminalId, terminal);
      try {
        await terminal.descendants?.capture(terminal.processHelperTimeoutMs);
        assertControlAuthority(authority);
      } catch (error) {
        await this.releaseTerminal({ terminalId, sessionId: params.sessionId });
        throw error;
      }

      this.emitOperation({
        method: "terminal/create",
        status: "completed",
        summary,
        details: `terminalId=${terminalId}`,
        timestamp: nowIso(),
      });
      return { terminalId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "terminal/create",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const hasExitStatus = terminal.exitCode !== undefined || terminal.signal !== undefined;

    this.emitOperation({
      method: "terminal/output",
      status: "completed",
      summary: `terminal/output: ${params.terminalId}`,
      timestamp: nowIso(),
    });

    return {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
      exitStatus: hasExitStatus
        ? {
            exitCode: terminal.exitCode ?? null,
            signal: terminal.signal ?? null,
          }
        : undefined,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const response = await terminal.exitPromise;
    this.emitOperation({
      method: "terminal/wait_for_exit",
      status: "completed",
      summary: `terminal/wait_for_exit: ${params.terminalId}`,
      details: `exitCode=${response.exitCode ?? "null"}, signal=${response.signal ?? "null"}`,
      timestamp: nowIso(),
    });
    return response;
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const summary = `terminal/kill: ${params.terminalId}`;
    this.emitOperation({
      method: "terminal/kill",
      status: "running",
      summary,
      timestamp: nowIso(),
    });

    try {
      await this.killProcess(terminal);
      this.emitOperation({
        method: "terminal/kill",
        status: "completed",
        summary,
        timestamp: nowIso(),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "terminal/kill",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const summary = `terminal/release: ${params.terminalId}`;
    this.emitOperation({
      method: "terminal/release",
      status: "running",
      summary,
      timestamp: nowIso(),
    });

    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      this.emitOperation({
        method: "terminal/release",
        status: "completed",
        summary,
        details: "already released",
        timestamp: nowIso(),
      });
      return {};
    }

    try {
      await this.killProcess(terminal);
      await terminal.exitPromise.catch(() => {
        // ignore best-effort wait failures
      });
      terminal.descendants?.retire();
      terminal.process.stdout.destroy();
      terminal.process.stderr.destroy();
      terminal.output = Buffer.alloc(0);
      this.terminals.delete(params.terminalId);

      this.emitOperation({
        method: "terminal/release",
        status: "completed",
        summary,
        timestamp: nowIso(),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "terminal/release",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.terminals.keys(), (terminalId) =>
        this.releaseTerminal({ terminalId, sessionId: "shutdown" }),
      ),
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Terminal shutdown failed", { cause: failures[0] });
    }
  }

  private getTerminal(terminalId: string): ManagedTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  private emitOperation(operation: ClientOperation): void {
    this.onOperation?.(operation);
  }

  private async isExecuteApproved(commandLine: string, signal?: AbortSignal): Promise<boolean> {
    if (this.permissionMode === "approve-all") {
      return true;
    }
    if (this.permissionMode === "deny-all") {
      return false;
    }
    if (
      this.usesDefaultConfirmExecute &&
      this.nonInteractivePermissions === "fail" &&
      !canPromptForPermission()
    ) {
      throw new PermissionPromptUnavailableError();
    }
    return await this.confirmExecute(commandLine, signal);
  }

  private isRunning(terminal: ManagedTerminal): boolean {
    return terminal.exitCode === undefined && terminal.signal === undefined;
  }

  private async killProcess(terminal: ManagedTerminal): Promise<void> {
    if (!this.isRunning(terminal) && !tracksTerminalDescendants(terminal)) {
      return;
    }

    try {
      await this.signalProcess(terminal, "SIGTERM");
    } catch {
      return;
    }

    const exitedAfterTerm = await this.waitForCleanupAfterSignal(terminal);
    if (exitedAfterTerm && (!terminal.killProcessGroup || terminal.descendants)) {
      return;
    }

    try {
      await this.signalProcess(terminal, "SIGKILL");
    } catch {
      return;
    }

    await this.waitForFinalCleanup(terminal);
  }

  private async signalProcess(terminal: ManagedTerminal, signal: NodeJS.Signals): Promise<void> {
    if (terminal.descendants) {
      // Signal each witnessed process once, including children that left the group.
      await terminal.descendants.signal(signal, terminal.processHelperTimeoutMs);
      if (this.isRunning(terminal)) {
        terminal.process.kill(signal);
      }
      return;
    }
    const pid = terminal.process.pid;
    if (terminal.killProcessGroup && pid && process.platform === "win32") {
      await this.signalWindowsProcessGroup(terminal, pid, signal);
      return;
    }
    terminal.process.kill(signal);
  }

  private async signalWindowsProcessGroup(
    terminal: ManagedTerminal,
    pid: number,
    signal: NodeJS.Signals,
  ): Promise<void> {
    await this.captureDescendantPids(terminal, pid);
    if (this.isRunning(terminal)) {
      await killWindowsProcessTree(pid, signal, terminal.processHelperTimeoutMs);
      return;
    }
    for (const descendantPid of terminal.descendantPids) {
      await killWindowsProcessTree(descendantPid, signal, terminal.processHelperTimeoutMs);
    }
  }

  private async captureDescendantPids(terminal: ManagedTerminal, pid: number): Promise<void> {
    if (!this.isRunning(terminal)) {
      await terminal.processGroupSnapshotPromise?.catch(() => {
        // ignore best-effort process group snapshot failures
      });
    }
    for (const descendantPid of await listDescendantPids(pid, terminal.processHelperTimeoutMs)) {
      terminal.descendantPids.add(descendantPid);
    }
  }

  private async waitForFinalCleanup(terminal: ManagedTerminal): Promise<void> {
    const cleaned = await this.waitForCleanupAfterSignal(terminal);
    if (!cleaned && process.platform === "win32") {
      throw new Error("Terminal process cleanup did not finish after SIGKILL");
    }
  }

  private async waitForCleanupAfterSignal(terminal: ManagedTerminal): Promise<boolean> {
    const deadline = performance.now() + this.killGraceMs;
    // This deadline owns every poll, including the exit snapshot. Racing an
    // unbounded waiter leaves timers retaining terminal state after cleanup returns.
    while (
      this.isRunning(terminal) ||
      terminal.processGroupSnapshotPromise ||
      (await hasLiveTerminalDescendants(terminal, deadline - performance.now())) ||
      hasLivePid(terminal.descendantPids)
    ) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return false;
      }
      await waitMs(Math.min(25, remaining));
    }
    return true;
  }
}

async function spawnTerminalProcess(
  params: CreateTerminalRequest,
  defaultCwd: string,
  authority?: AcpControlAuthority,
): Promise<{
  proc: ChildProcessByStdio<null, Readable, Readable>;
  spawnCommand: TerminalSpawnCommand;
}> {
  const directCommand = buildTerminalSpawnCommand(params.command, params.args);
  try {
    return {
      proc: await spawnAndWait(directCommand, params, defaultCwd, authority),
      spawnCommand: directCommand,
    };
  } catch (error) {
    const fallbackCommand =
      params.args === undefined && isNotFoundSpawnError(error)
        ? buildTerminalFallbackSpawnCommand(params.command, params.cwd ?? defaultCwd)
        : undefined;
    if (!fallbackCommand) {
      throw error;
    }
    return {
      proc: await spawnAndWait(fallbackCommand, params, defaultCwd, authority),
      spawnCommand: fallbackCommand,
    };
  }
}

async function spawnAndWait(
  spawnCommand: TerminalSpawnCommand,
  params: CreateTerminalRequest,
  defaultCwd: string,
  authority?: AcpControlAuthority,
): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const spawnOptions = buildTerminalSpawnOptions(
    spawnCommand.command,
    params.cwd ?? defaultCwd,
    params.env,
  );
  if (spawnCommand.killProcessGroup || process.platform !== "win32") {
    spawnOptions.detached = true;
  }
  // ACP terminal/create is a permission-gated command-execution surface.
  // CodeQL otherwise treats the intentional shell fallback as accidental injection.
  assertControlAuthority(authority);
  // codeql[js/shell-command-injection-from-environment]
  // lgtm[js/shell-command-injection-from-environment]
  const proc = spawn(spawnCommand.command, spawnCommand.args, spawnOptions);
  await waitForSpawn(proc);
  return proc;
}

function isNotFoundSpawnError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function buildTerminalFallbackSpawnCommand(
  command: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnCommand | undefined {
  if (commandPathExists(command, cwd)) {
    return undefined;
  }

  if (platform === "win32") {
    return hasWindowsShellSyntax(command) || /\s/u.test(command)
      ? buildTerminalShellSpawnCommand(command, platform)
      : undefined;
  }

  if (hasShellSyntax(command) || /\s/u.test(command)) {
    return buildTerminalShellSpawnCommand(command, platform);
  }

  return undefined;
}

function hasShellSyntax(command: string): boolean {
  return /[|&;<>()>$`*?[\]{}'"\\\r\n]/u.test(command);
}

function hasWindowsShellSyntax(command: string): boolean {
  return /[|&;<>()>$`*?[\]{}'"\r\n]/u.test(command);
}

function commandPathExists(command: string, cwd: string): boolean {
  if (!/[\\/]/u.test(command)) {
    return false;
  }
  const resolvedPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
  return fs.existsSync(resolvedPath);
}

async function listDescendantPids(rootPid: number, timeoutMs: number): Promise<number[]> {
  let output: string;
  try {
    output = await runWindowsProcessListCommand(timeoutMs);
  } catch {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    addProcessListLine(childrenByParent, line);
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function addProcessListLine(childrenByParent: Map<number, number[]>, line: string): void {
  const parsed = parseProcessListLine(line);
  if (!parsed) {
    return;
  }

  const children = childrenByParent.get(parsed.parentPid);
  if (children) {
    children.push(parsed.pid);
  } else {
    childrenByParent.set(parsed.parentPid, [parsed.pid]);
  }
}

function parseProcessListLine(line: string): { pid: number; parentPid: number } | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return undefined;
  }

  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) {
    return undefined;
  }
  return { pid, parentPid };
}

async function rememberProcessGroupPids(terminal: ManagedTerminal): Promise<void> {
  const processGroupId = terminal.process.pid;
  if (!terminal.killProcessGroup || !processGroupId) {
    return;
  }

  for (const pid of await listDescendantPids(processGroupId, terminal.processHelperTimeoutMs)) {
    terminal.descendantPids.add(pid);
  }
}

async function runWindowsProcessListCommand(timeoutMs: number): Promise<string> {
  const command = [
    "Get-CimInstance Win32_Process |",
    'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
  ].join(" ");
  return await runTimedExecFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeoutMs, windowsHide: true },
  );
}

export async function killWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  timeoutMs: number = PROCESS_HELPER_TIMEOUT_MS,
): Promise<void> {
  const args = ["/pid", String(pid), "/t"];
  if (signal === "SIGKILL") {
    args.push("/f");
  }
  try {
    await runTimedExecFile("taskkill", args, { timeoutMs, windowsHide: true });
  } catch {
    // Hung or missing taskkill must not block terminal/kill or terminal/release.
  }
}

async function hasLiveTerminalDescendants(
  terminal: ManagedTerminal,
  timeoutMs: number,
): Promise<boolean> {
  const descendants = terminal.descendants;
  if (!descendants) {
    return false;
  }
  if (timeoutMs > 0) {
    await descendants.capture(Math.min(terminal.processHelperTimeoutMs, timeoutMs));
  }
  return descendants.hasTrackedProcesses();
}

function hasLivePid(pids: Set<number>): boolean {
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      pids.delete(pid);
    }
  }
  return false;
}
