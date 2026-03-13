#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  type ContentBlock,
  PROTOCOL_VERSION,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type SessionId,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

type PermissionMode = "approve-all" | "deny-all";
type OutputFormat = "text" | "json";
type TimeoutKind = "request" | "update";

type CliOptions = {
  profilePath: string;
  casesDir: string;
  agentCommand: string;
  agentCommandCwd: string;
  permissionMode: PermissionMode;
  format: OutputFormat;
  reportPath?: string;
  cwd: string;
  onlyCaseIds: Set<string> | undefined;
};

type ProfileDefinition = {
  id: string;
  required_cases: string[];
};

type CaseDefinition = {
  id: string;
  title?: string;
  permission_mode?: PermissionMode;
  steps?: CaseStep[];
  checks?: CaseCheck[];
  timeouts?: {
    request_timeout_ms?: number;
    update_timeout_ms?: number;
    settle_timeout_ms?: number;
  };
};

type ErrorExpectation = {
  codes?: number[];
  message_any?: string[];
};

type CaseStep =
  | {
      action: "new_session";
      cwd?: unknown;
      save_as?: string;
      expect_error?: ErrorExpectation;
    }
  | {
      action: "prompt";
      session: unknown;
      prompt: ContentBlock[];
      save_as?: string;
      expect_error?: ErrorExpectation;
      suppress_console_error?: boolean;
    }
  | {
      action: "prompt_background";
      session: unknown;
      prompt: ContentBlock[];
      save_as: string;
    }
  | {
      action: "await_background";
      from: string;
      save_as?: string;
      expect_error?: ErrorExpectation;
    }
  | {
      action: "cancel";
      session: unknown;
      expect_error?: ErrorExpectation;
    }
  | {
      action: "sleep";
      ms: number;
    };

type CaseCheck =
  | {
      type: "initialize_protocol_version_number";
    }
  | {
      type: "saved_non_empty_string";
      key: string;
    }
  | {
      type: "saved_error_present";
      key: string;
    }
  | {
      type: "saved_stop_reason_in";
      key: string;
      values: string[];
    }
  | {
      type: "updates_count_at_least";
      min: number;
    }
  | {
      type: "updates_all_session";
      session: string;
    }
  | {
      type: "updates_text_includes";
      text: string;
    };

type CaseResult = {
  id: string;
  title: string;
  passed: boolean;
  durationMs: number;
  error?: string;
};

type RunReport = {
  profileId: string;
  startedAt: string;
  completedAt: string;
  agentCommand: string;
  cwd: string;
  permissionMode: PermissionMode;
  totals: {
    cases: number;
    passed: number;
    failed: number;
  };
  results: CaseResult[];
};

type Harness = {
  connection: ClientSideConnection;
  client: RunnerClient;
  initializeResult: InitializeResponse;
  shutdown: () => Promise<void>;
};

type ParsedCommand = {
  command: string;
  args: string[];
};

type ExecutionContext = {
  saved: Record<string, unknown>;
  background: Map<string, Promise<PromptResponse>>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePathWithinRoot(rootDir: string, rawPath: string): string {
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(rootDir, rawPath);
  if (!isWithinRoot(rootDir, resolved)) {
    throw new RequestError(-32001, `Path is outside session cwd root: ${resolved}`);
  }
  return resolved;
}

class RunnerClient implements Client {
  readonly updates: SessionNotification[] = [];
  private readonly permissionMode: PermissionMode;
  private readonly defaultSessionCwd: string;
  private readonly sessionCwds = new Map<SessionId, string>();
  private readonly createdFiles = new Set<string>();

  constructor(params: { permissionMode: PermissionMode; defaultSessionCwd: string }) {
    this.permissionMode = params.permissionMode;
    this.defaultSessionCwd = path.resolve(params.defaultSessionCwd);
  }

  registerSessionCwd(sessionId: SessionId, cwd: string): void {
    this.sessionCwds.set(sessionId, path.resolve(cwd));
  }

  async requestPermission(params: {
    options: Array<{
      optionId: string;
      kind: string;
    }>;
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
    const options = params.options ?? [];
    if (options.length === 0) {
      return { outcome: { outcome: "cancelled" } };
    }

    if (this.permissionMode === "approve-all") {
      const allow = options.find(
        (option) => option.kind === "allow_once" || option.kind === "allow_always",
      );
      return { outcome: { outcome: "selected", optionId: (allow ?? options[0]).optionId } };
    }

    const reject = options.find(
      (option) => option.kind === "reject_once" || option.kind === "reject_always",
    );
    if (reject) {
      return { outcome: { outcome: "selected", optionId: reject.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const filePath = this.resolveSessionPath(params);
    if (this.permissionMode === "deny-all") {
      throw new RequestError(-32001, "Permission denied by conformance runner");
    }
    const content = await fs.readFile(filePath, "utf8");
    return { content };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const filePath = this.resolveSessionPath(params);
    if (this.permissionMode === "deny-all") {
      throw new RequestError(-32001, "Permission denied by conformance runner");
    }
    const fileDidExist = await this.pathExists(filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.content, "utf8");
    if (!fileDidExist) {
      this.createdFiles.add(filePath);
    }
    return {};
  }

  async cleanup(): Promise<void> {
    for (const filePath of this.createdFiles) {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        // Best-effort cleanup for scratch files created by conformance cases.
      }
    }
    this.createdFiles.clear();
  }

  private resolveSessionPath(params: { sessionId: SessionId; path: string }): string {
    const sessionCwd = this.sessionCwds.get(params.sessionId) ?? this.defaultSessionCwd;
    return resolvePathWithinRoot(sessionCwd, params.path);
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    profilePath: path.resolve("conformance/profiles/acp-core-v1.json"),
    casesDir: path.resolve("conformance/cases"),
    agentCommand: "tsx test/mock-agent.ts",
    agentCommandCwd: process.cwd(),
    permissionMode: "approve-all",
    format: "text",
    cwd: process.cwd(),
    onlyCaseIds: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      continue;
    }
    if (token === "--profile") {
      options.profilePath = path.resolve(readArgValue(argv, ++i, "--profile"));
      continue;
    }
    if (token === "--cases-dir") {
      options.casesDir = path.resolve(readArgValue(argv, ++i, "--cases-dir"));
      continue;
    }
    if (token === "--agent-command") {
      options.agentCommand = readArgValue(argv, ++i, "--agent-command");
      continue;
    }
    if (token === "--permission-mode") {
      const mode = readArgValue(argv, ++i, "--permission-mode");
      if (mode !== "approve-all" && mode !== "deny-all") {
        throw new Error(`Invalid --permission-mode: ${mode}`);
      }
      options.permissionMode = mode;
      continue;
    }
    if (token === "--format") {
      const format = readArgValue(argv, ++i, "--format");
      if (format !== "text" && format !== "json") {
        throw new Error(`Invalid --format: ${format}`);
      }
      options.format = format;
      continue;
    }
    if (token === "--report") {
      options.reportPath = path.resolve(readArgValue(argv, ++i, "--report"));
      continue;
    }
    if (token === "--cwd") {
      options.cwd = path.resolve(readArgValue(argv, ++i, "--cwd"));
      continue;
    }
    if (token === "--case") {
      const caseId = readArgValue(argv, ++i, "--case");
      if (!options.onlyCaseIds) {
        options.onlyCaseIds = new Set();
      }
      options.onlyCaseIds.add(caseId);
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(
    `ACP conformance runner (draft)

Usage:
  tsx conformance/runner/run.ts [options]

Options:
  --profile <path>           Profile JSON path (default: conformance/profiles/acp-core-v1.json)
  --cases-dir <path>         Cases directory (default: conformance/cases)
  --agent-command <command>  Adapter command (default: "tsx test/mock-agent.ts")
  --permission-mode <mode>   approve-all | deny-all (default: approve-all)
  --format <fmt>             text | json (default: text)
  --report <path>            Write full JSON report to file
  --cwd <path>               Cwd sent to session/new (default: current dir)
  --case <id>                Run only one case id (repeatable)
  -h, --help                 Show help
`,
  );
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value.trim();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return awaitWithTimeout(promise, timeoutMs, label);
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveTimeoutMs(
  caseDefinition: CaseDefinition,
  kind: TimeoutKind,
  fallbackMs: number,
): number {
  if (kind === "request") {
    const value = caseDefinition.timeouts?.request_timeout_ms;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
    return fallbackMs;
  }

  const value = caseDefinition.timeouts?.update_timeout_ms;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallbackMs;
}

function splitCommandLine(value: string): ParsedCommand {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  if (quote) {
    throw new Error(`Invalid command line: ${value}`);
  }
  if (parts.length === 0) {
    throw new Error("Agent command is required");
  }

  return { command: parts[0], args: parts.slice(1) };
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read JSON file ${filePath}: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse JSON ${filePath}: ${toErrorMessage(error)}`, { cause: error });
  }
}

async function loadProfileAndCases(options: CliOptions): Promise<{
  profile: ProfileDefinition;
  casesById: Map<string, CaseDefinition>;
  selectedCaseIds: string[];
}> {
  const profile = await loadJsonFile<ProfileDefinition>(options.profilePath);
  if (!profile || typeof profile.id !== "string" || !Array.isArray(profile.required_cases)) {
    throw new Error(`Invalid profile file: ${options.profilePath}`);
  }

  const caseFiles = (await fs.readdir(options.casesDir))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(options.casesDir, name));
  const casesById = new Map<string, CaseDefinition>();

  for (const filePath of caseFiles) {
    const definition = await loadJsonFile<CaseDefinition>(filePath);
    if (!definition || typeof definition.id !== "string") {
      throw new Error(`Invalid case file (missing id): ${filePath}`);
    }
    casesById.set(definition.id, definition);
  }

  for (const requiredCase of profile.required_cases) {
    if (!casesById.has(requiredCase)) {
      throw new Error(`Profile references missing case id: ${requiredCase}`);
    }
  }

  const selected = profile.required_cases.filter((id) => {
    if (!options.onlyCaseIds) {
      return true;
    }
    return options.onlyCaseIds.has(id);
  });

  if (selected.length === 0) {
    throw new Error("No cases selected");
  }

  return {
    profile,
    casesById,
    selectedCaseIds: selected,
  };
}

async function createHarness(options: CliOptions): Promise<Harness> {
  const parsed = splitCommandLine(options.agentCommand);
  const child = spawn(parsed.command, parsed.args, {
    cwd: options.agentCommandCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to create stdio pipes for agent process");
  }

  let stderrBuffer = "";
  child.stderr?.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);
  const client = new RunnerClient({
    permissionMode: options.permissionMode,
    defaultSessionCwd: options.cwd,
  });
  const connection = new ClientSideConnection(() => client, stream);
  let initializeResult: InitializeResponse;
  let cleanedUp = false;
  const waitForSpawn = new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(
        new Error(`failed to spawn agent process: ${toErrorMessage(error)}`, { cause: error }),
      );
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  const cleanupClientState = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await client.cleanup();
  };

  const shutdown = async (): Promise<void> => {
    if (child.killed || child.exitCode !== null) {
      await cleanupClientState();
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      setTimeout(() => resolve(), 2500);
    });
    await cleanupClientState();
  };

  try {
    await waitForSpawn;
    initializeResult = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
        clientInfo: {
          name: "acpx-conformance-runner",
          version: "0.1.0",
        },
      }),
      DEFAULT_INITIALIZE_TIMEOUT_MS,
      "initialize",
    );
  } catch (error) {
    await shutdown();
    const detail = stderrBuffer.trim();
    const suffix = detail.length > 0 ? `\nagent stderr:\n${detail}` : "";
    throw new Error(`initialize failed: ${toErrorMessage(error)}${suffix}`, { cause: error });
  }

  return {
    connection,
    client,
    initializeResult: initializeResult!,
    shutdown,
  };
}

function assertString(value: unknown, message: string): asserts value is string {
  assert.equal(typeof value, "string", message);
  assert.notEqual((value as string).trim().length, 0, message);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function withSuppressedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = originalConsoleError;
  }
}

function resolveMaybeSavedRef(value: unknown, saved: Record<string, unknown>): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const fromDollar = value.startsWith("$") ? value.slice(1) : value;
  const fromTemplate =
    fromDollar.startsWith("${saved.") && fromDollar.endsWith("}")
      ? fromDollar.slice("${saved.".length, -1)
      : fromDollar;

  if (Object.prototype.hasOwnProperty.call(saved, fromTemplate)) {
    const resolved = saved[fromTemplate];
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved;
    }
    throw new Error(`Saved reference "${fromTemplate}" is not a non-empty string`);
  }

  if (fromDollar.startsWith("${saved.")) {
    throw new Error(`Unknown saved reference: ${fromDollar}`);
  }

  return value;
}

function validateExpectedError(error: unknown, expectation: ErrorExpectation | undefined): void {
  if (!expectation) {
    return;
  }

  const code = extractErrorCode(error);
  const message = toErrorMessage(error).toLowerCase();

  if (Array.isArray(expectation.codes) && expectation.codes.length > 0) {
    assert.equal(
      expectation.codes.includes(code ?? Number.NaN),
      true,
      `Unexpected error code ${String(code)}; expected one of ${expectation.codes.join(", ")}`,
    );
  }

  if (Array.isArray(expectation.message_any) && expectation.message_any.length > 0) {
    const matched = expectation.message_any.some((fragment) =>
      message.includes(fragment.toLowerCase()),
    );
    assert.equal(
      matched,
      true,
      `Unexpected error message "${message}" (expected one of: ${expectation.message_any.join(", ")})`,
    );
  }
}

async function executeWithExpectation<T>(params: {
  label: string;
  timeoutMs: number;
  expectError?: ErrorExpectation;
  operation: () => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    const value = await withTimeout(params.operation(), params.timeoutMs, params.label);
    if (params.expectError) {
      throw new Error(`${params.label} succeeded but error was expected`);
    }
    return { ok: true, value };
  } catch (error) {
    if (!params.expectError) {
      throw error;
    }
    validateExpectedError(error, params.expectError);
    return { ok: false, error };
  }
}

async function executeCaseStep(params: {
  step: CaseStep;
  harness: Harness;
  context: ExecutionContext;
  options: CliOptions;
  requestTimeoutMs: number;
  updateTimeoutMs: number;
}): Promise<void> {
  const { step, harness, context, options, requestTimeoutMs, updateTimeoutMs } = params;

  switch (step.action) {
    case "sleep": {
      assert.equal(
        Number.isFinite(step.ms) && step.ms >= 0,
        true,
        `Invalid sleep.ms: ${String(step.ms)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.round(step.ms)));
      return;
    }

    case "new_session": {
      const cwdCandidate = step.cwd === undefined ? options.cwd : step.cwd;
      const result = await executeWithExpectation({
        label: "session/new",
        timeoutMs: requestTimeoutMs,
        expectError: step.expect_error,
        operation: async () => {
          return await harness.connection.newSession({
            cwd: cwdCandidate as string,
            mcpServers: [],
          });
        },
      });

      if (
        result.ok &&
        typeof result.value.sessionId === "string" &&
        typeof cwdCandidate === "string"
      ) {
        harness.client.registerSessionCwd(result.value.sessionId, cwdCandidate);
      }

      if (step.save_as) {
        context.saved[step.save_as] =
          result.ok && typeof result.value.sessionId === "string"
            ? result.value.sessionId
            : result.ok
              ? result.value
              : result.error;
      }
      return;
    }

    case "prompt": {
      const sessionId = resolveMaybeSavedRef(step.session, context.saved);
      const runPrompt = async () => {
        return await harness.connection.prompt({
          sessionId: sessionId as SessionId,
          prompt: step.prompt,
        });
      };

      const result = await executeWithExpectation({
        label: "session/prompt",
        timeoutMs: updateTimeoutMs,
        expectError: step.expect_error,
        operation: async () => {
          if (step.suppress_console_error) {
            return await withSuppressedConsoleError(runPrompt);
          }
          return await runPrompt();
        },
      });

      if (step.save_as) {
        context.saved[step.save_as] = result.ok ? result.value : result.error;
      }
      return;
    }

    case "prompt_background": {
      const sessionId = resolveMaybeSavedRef(step.session, context.saved);
      context.background.set(
        step.save_as,
        harness.connection.prompt({
          sessionId: sessionId as SessionId,
          prompt: step.prompt,
        }),
      );
      return;
    }

    case "await_background": {
      const pending = context.background.get(step.from);
      if (!pending) {
        throw new Error(`Unknown background prompt reference: ${step.from}`);
      }

      const result = await executeWithExpectation({
        label: `await_background:${step.from}`,
        timeoutMs: updateTimeoutMs,
        expectError: step.expect_error,
        operation: async () => await pending,
      });

      if (step.save_as) {
        context.saved[step.save_as] = result.ok ? result.value : result.error;
      }
      return;
    }

    case "cancel": {
      const sessionId = resolveMaybeSavedRef(step.session, context.saved);
      await executeWithExpectation({
        label: "session/cancel",
        timeoutMs: requestTimeoutMs,
        expectError: step.expect_error,
        operation: async () => {
          return await harness.connection.cancel({ sessionId: sessionId as SessionId });
        },
      });
      return;
    }
  }
}

function evaluateCaseChecks(params: {
  caseDefinition: CaseDefinition;
  harness: Harness;
  context: ExecutionContext;
}): void {
  const checks = params.caseDefinition.checks ?? [];
  for (const check of checks) {
    switch (check.type) {
      case "initialize_protocol_version_number": {
        assert.equal(typeof params.harness.initializeResult.protocolVersion, "number");
        break;
      }
      case "saved_non_empty_string": {
        const value = params.context.saved[check.key];
        assertString(value, `saved.${check.key} must be a non-empty string`);
        break;
      }
      case "saved_error_present": {
        const value = params.context.saved[check.key];
        assert.notEqual(value == null, true, `saved.${check.key} must be present`);
        break;
      }
      case "saved_stop_reason_in": {
        const value = params.context.saved[check.key] as { stopReason?: unknown } | undefined;
        assert.notEqual(value == null, true, `saved.${check.key} must be present`);
        assert.equal(
          check.values.includes(String(value?.stopReason)),
          true,
          `saved.${check.key}.stopReason must be in [${check.values.join(", ")}]`,
        );
        break;
      }
      case "updates_count_at_least": {
        assert.equal(
          params.harness.client.updates.length >= check.min,
          true,
          `expected at least ${check.min} updates`,
        );
        break;
      }
      case "updates_all_session": {
        const session = resolveMaybeSavedRef(check.session, params.context.saved);
        for (const update of params.harness.client.updates) {
          assert.equal(update.sessionId, session, "every update must reference expected session");
        }
        break;
      }
      case "updates_text_includes": {
        const needle = check.text.toLowerCase();
        const matched = params.harness.client.updates.some((update) => {
          const updateRecord = update.update as { content?: { type?: string; text?: string } };
          return (
            updateRecord.content?.type === "text" &&
            typeof updateRecord.content.text === "string" &&
            updateRecord.content.text.toLowerCase().includes(needle)
          );
        });
        assert.equal(matched, true, `expected at least one update text including "${check.text}"`);
        break;
      }
    }
  }
}

async function runCase(
  caseDefinition: CaseDefinition,
  options: CliOptions,
): Promise<{ passed: true } | { passed: false; error: string }> {
  const requestTimeoutMs = resolveTimeoutMs(caseDefinition, "request", DEFAULT_REQUEST_TIMEOUT_MS);
  const updateTimeoutMs = resolveTimeoutMs(caseDefinition, "update", DEFAULT_UPDATE_TIMEOUT_MS);
  const effectiveOptions: CliOptions =
    caseDefinition.permission_mode && caseDefinition.permission_mode !== options.permissionMode
      ? { ...options, permissionMode: caseDefinition.permission_mode }
      : options;
  let harness: Harness | undefined;
  const context: ExecutionContext = {
    saved: {},
    background: new Map(),
  };
  try {
    harness = await createHarness(effectiveOptions);
    const activeHarness = harness;
    for (const step of caseDefinition.steps ?? []) {
      await executeCaseStep({
        step,
        harness: activeHarness,
        context,
        options: effectiveOptions,
        requestTimeoutMs,
        updateTimeoutMs,
      });
    }

    evaluateCaseChecks({
      caseDefinition,
      harness: activeHarness,
      context,
    });
    return { passed: true };
  } catch (error) {
    return { passed: false, error: toErrorMessage(error) };
  } finally {
    await harness?.shutdown();
  }
}

function extractErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === "number") {
    return record.code;
  }
  if (
    record.cause &&
    typeof record.cause === "object" &&
    typeof (record.cause as { code?: unknown }).code === "number"
  ) {
    return (record.cause as { code: number }).code;
  }
  return undefined;
}

function printTextSummary(report: RunReport): void {
  const passed = report.totals.passed;
  const failed = report.totals.failed;
  const lines = [
    `Profile: ${report.profileId}`,
    `Cases: ${report.totals.cases}  Passed: ${passed}  Failed: ${failed}`,
    "",
    "Result Matrix:",
  ];

  for (const result of report.results) {
    const symbol = result.passed ? "PASS" : "FAIL";
    const base = `- [${symbol}] ${result.id} (${result.durationMs}ms)`;
    lines.push(result.error ? `${base} -> ${result.error}` : base);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const options = parseArgs(process.argv.slice(2));
  const { profile, casesById, selectedCaseIds } = await loadProfileAndCases(options);

  const results: CaseResult[] = [];

  for (const caseId of selectedCaseIds) {
    const definition = casesById.get(caseId);
    assert(definition, `missing case definition: ${caseId}`);
    const startedAt = Date.now();
    const result = await runCase(definition, options);
    results.push({
      id: caseId,
      title: definition.title ?? caseId,
      passed: result.passed,
      durationMs: Date.now() - startedAt,
      error: result.passed ? undefined : result.error,
    });
  }

  const passed = results.filter((result) => result.passed).length;
  const report: RunReport = {
    profileId: profile.id,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date().toISOString(),
    agentCommand: options.agentCommand,
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    totals: {
      cases: results.length,
      passed,
      failed: results.length - passed,
    },
    results,
  };

  if (options.reportPath) {
    await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
    await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    printTextSummary(report);
  }

  if (report.totals.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`conformance runner failed: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});
