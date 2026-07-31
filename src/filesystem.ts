import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
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
  confirmWrite?: (filePath: string, preview: string) => Promise<boolean>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalizeRootDir(resolved: string): string {
  // The cwd may not exist yet (it is created on first write), so fall back
  // to canonicalizing the deepest existing ancestor rather than throwing.
  // A dangling-symlink cwd resolves to its lexical form here and is then
  // rejected per-operation by resolvePathWithinRoot.
  let ancestor = resolved;
  for (;;) {
    try {
      return path.join(realpathSync(ancestor), path.relative(ancestor, resolved));
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return resolved;
      }
      ancestor = parent;
    }
  }
}

async function existsAsEntry(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

// Canonicalize `resolved` so symlinks cannot escape the sandbox. If the path
// itself does not exist (e.g. a write to a new file), walk up to the deepest
// existing parent, canonicalize that, and rebuild the leaf onto it. A path
// component that exists per lstat but fails realpath (a dangling symlink or a
// symlink loop) is rejected: falling back to its lexical form would let a
// subsequent write follow the link to an external target.
async function canonicalizeForContainment(resolved: string): Promise<string> {
  try {
    return await fs.realpath(resolved);
  } catch {
    if (await existsAsEntry(resolved)) {
      throw new Error(`Path contains an unresolvable symlink: ${resolved}`);
    }
  }
  // The walk is bounded only by the filesystem root: `ancestor` is derived
  // from the lexical path while the caller's rootDir is canonical, so the two
  // are not comparable and any length-based bound here would skip the walk
  // whenever the lexical cwd is shorter than its canonical target.
  let ancestor = path.dirname(resolved);
  for (;;) {
    try {
      return path.join(await fs.realpath(ancestor), path.relative(ancestor, resolved));
    } catch {
      if (await existsAsEntry(ancestor)) {
        throw new Error(`Path contains an unresolvable symlink: ${resolved}`);
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return resolved; // reached the filesystem root
      }
      ancestor = parent;
    }
  }
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

async function defaultConfirmWrite(filePath: string, preview: string): Promise<boolean> {
  return await promptForPermission({
    header: `[permission] Allow write to ${filePath}?`,
    details: preview,
    prompt: "Allow write? (y/N) ",
  });
}

function canPromptForPermission(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

export class FileSystemHandlers {
  private readonly rootDir: string;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissionPolicy;
  private readonly onOperation?: (operation: ClientOperation) => void;
  private readonly usesDefaultConfirmWrite: boolean;
  private readonly confirmWrite: (filePath: string, preview: string) => Promise<boolean>;

  constructor(options: FileSystemHandlersOptions) {
    this.rootDir = canonicalizeRootDir(path.resolve(options.cwd));
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

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const filePath = await this.resolvePathWithinRoot(params.path);
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

      const content = await fs.readFile(filePath, "utf8");
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

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const filePath = await this.resolvePathWithinRoot(params.path);
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
      if (!(await this.isWriteApproved(filePath, preview))) {
        throw new PermissionDeniedError("Permission denied for fs/write_text_file");
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, "utf8");

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

  private async isWriteApproved(filePath: string, preview: string): Promise<boolean> {
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
    return await this.confirmWrite(filePath, preview);
  }

  private async resolvePathWithinRoot(rawPath: string): Promise<string> {
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`Path must be absolute: ${rawPath}`);
    }
    const realPath = await canonicalizeForContainment(path.resolve(rawPath));
    if (!isWithinRoot(this.rootDir, realPath)) {
      throw new Error(`Path is outside allowed cwd subtree: ${realPath}`);
    }
    return realPath;
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
