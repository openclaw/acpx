import path from "node:path";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { isPathInside } from "@openclaw/fs-safe/path";
import { root, type Root } from "@openclaw/fs-safe/root";
import { assertControlAuthority, type AcpControlAuthority } from "./async-control.js";
import { PermissionDeniedError, PermissionPromptUnavailableError } from "./errors.js";
import { promptForPermission } from "./permission-prompt.js";
import type { ClientOperation, NonInteractivePermissionPolicy, PermissionMode } from "./types.js";

const WRITE_PREVIEW_MAX_LINES = 16;
const WRITE_PREVIEW_MAX_CHARS = 1_200;

export type FileSystemHandlersOptions = {
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  onOperation?: (operation: ClientOperation) => void;
  confirmWrite?: (filePath: string, preview: string, signal?: AbortSignal) => Promise<boolean>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toWritePreview(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const visibleLines = lines.slice(0, WRITE_PREVIEW_MAX_LINES);
  let preview = visibleLines.join("\n");

  if (lines.length > visibleLines.length) {
    preview += `\n... (${lines.length - visibleLines.length} more lines)`;
  }

  if (preview.length > WRITE_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, WRITE_PREVIEW_MAX_CHARS - 3)}...`;
  }

  return preview;
}

async function defaultConfirmWrite(
  filePath: string,
  preview: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return await promptForPermission({
    header: `[permission] Allow write to ${filePath}?`,
    details: preview,
    prompt: "Allow write? (y/N) ",
    signal,
  });
}

function canPromptForPermission(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

export class FileSystemHandlers {
  private readonly rootDir: string;
  private workspace?: Promise<Root>;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissionPolicy;
  private readonly onOperation?: (operation: ClientOperation) => void;
  private readonly usesDefaultConfirmWrite: boolean;
  private readonly confirmWrite: NonNullable<FileSystemHandlersOptions["confirmWrite"]>;

  constructor(options: FileSystemHandlersOptions) {
    this.rootDir = path.resolve(options.cwd);
    this.permissionMode = options.permissionMode;
    this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
    this.onOperation = options.onOperation;
    this.usesDefaultConfirmWrite = options.confirmWrite == null;
    this.confirmWrite = options.confirmWrite ?? defaultConfirmWrite;
  }

  updatePermissionPolicy(
    permissionMode: PermissionMode,
    nonInteractivePermissions?: NonInteractivePermissionPolicy,
  ): void {
    this.permissionMode = permissionMode;
    this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
  }

  async readTextFile(
    params: ReadTextFileRequest,
    authority?: AcpControlAuthority,
  ): Promise<ReadTextFileResponse> {
    assertControlAuthority(authority);
    const filePath = this.resolvePathWithinRoot(params.path);
    const summary = `read_text_file: ${filePath}`;
    this.emitOperation({
      method: "fs/read_text_file",
      status: "running",
      summary,
      details: this.readWindowDetails(params.line, params.limit),
      timestamp: nowIso(),
    });

    try {
      if (this.permissionMode === "deny-all") {
        throw new PermissionDeniedError("Permission denied for fs/read_text_file (--deny-all)");
      }

      const workspace = await this.getWorkspace();
      const content = await workspace.readText(
        `.${path.sep}${path.relative(this.rootDir, filePath)}`,
      );
      assertControlAuthority(authority);
      const sliced = this.sliceContent(content, params.line, params.limit);

      this.emitOperation({
        method: "fs/read_text_file",
        status: "completed",
        summary,
        details: this.readWindowDetails(params.line, params.limit),
        timestamp: nowIso(),
      });
      return { content: sliced };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "fs/read_text_file",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async writeTextFile(
    params: WriteTextFileRequest,
    authority?: AcpControlAuthority,
  ): Promise<WriteTextFileResponse> {
    assertControlAuthority(authority);
    const filePath = this.resolvePathWithinRoot(params.path);
    const preview = toWritePreview(params.content);
    const summary = `write_text_file: ${filePath}`;

    this.emitOperation({
      method: "fs/write_text_file",
      status: "running",
      summary,
      details: preview,
      timestamp: nowIso(),
    });

    try {
      const approved = await this.isWriteApproved(filePath, preview, authority?.signal);
      assertControlAuthority(authority);
      if (!approved) {
        throw new PermissionDeniedError("Permission denied for fs/write_text_file");
      }

      const workspace = await this.getWorkspace();
      const file = await workspace.openWritable(
        `.${path.sep}${path.relative(this.rootDir, filePath)}`,
        { mode: 0o666, assertBeforeMutation: () => assertControlAuthority(authority) },
      );
      try {
        assertControlAuthority(authority);
        await file.handle.writeFile(params.content, "utf8");
      } finally {
        await file.handle.close();
      }

      this.emitOperation({
        method: "fs/write_text_file",
        status: "completed",
        summary,
        details: preview,
        timestamp: nowIso(),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "fs/write_text_file",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  private async isWriteApproved(
    filePath: string,
    preview: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.permissionMode === "approve-all") {
      return true;
    }
    if (this.permissionMode === "deny-all") {
      return false;
    }
    if (
      this.usesDefaultConfirmWrite &&
      this.nonInteractivePermissions === "fail" &&
      !canPromptForPermission()
    ) {
      throw new PermissionPromptUnavailableError();
    }
    return await this.confirmWrite(filePath, preview, signal);
  }

  private resolvePathWithinRoot(rawPath: string): string {
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`Path must be absolute: ${rawPath}`);
    }
    const resolved = path.resolve(rawPath);
    if (!isPathInside(this.rootDir, resolved)) {
      throw new Error(`Path is outside allowed cwd subtree: ${resolved}`);
    }
    return resolved;
  }

  private getWorkspace(): Promise<Root> {
    return (this.workspace ??= root(this.rootDir, {
      symlinks: "follow-within-root",
      hardlinks: "allow",
      maxBytes: Infinity,
    }));
  }

  private sliceContent(
    content: string,
    line: number | null | undefined,
    limit: number | null | undefined,
  ): string {
    if (line == null && limit == null) {
      return content;
    }

    const lines = content.split("\n");
    const startLine = line == null ? 1 : Math.max(1, Math.trunc(line));
    const startIndex = Math.max(0, startLine - 1);
    const maxLines = limit == null ? undefined : Math.max(0, Math.trunc(limit));

    if (maxLines === 0) {
      return "";
    }

    const endIndex =
      maxLines == null ? lines.length : Math.min(lines.length, startIndex + maxLines);

    return lines.slice(startIndex, endIndex).join("\n");
  }

  private readWindowDetails(
    line: number | null | undefined,
    limit: number | null | undefined,
  ): string | undefined {
    if (line == null && limit == null) {
      return undefined;
    }
    const start = line == null ? 1 : Math.max(1, Math.trunc(line));
    const max = limit == null ? "all" : Math.max(0, Math.trunc(limit));
    return `line=${start}, limit=${max}`;
  }

  private emitOperation(operation: ClientOperation): void {
    this.onOperation?.(operation);
  }
}
