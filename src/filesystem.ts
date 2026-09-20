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

type ResolvedFsPath = {
  rootDir: string;
  filePath: string;
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
  private extraRoots = new Map<string, Promise<Root>>();
  private extraRootDirs: string[] = [];
  private skillTargets = new Map<string, string>();
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

  /**
   * Grants fs callbacks access to extra workspace roots (ACP
   * additionalDirectories); replaces previously granted roots. `skillTargets`
   * maps each synthetic skills root to the real skills dir.
   */
  setAdditionalRoots(
    dirs: readonly string[],
    skillTargets: ReadonlyMap<string, string> = new Map(),
  ): void {
    this.extraRootDirs = dirs.map((dir) => path.resolve(dir));
    this.skillTargets = new Map(
      [...skillTargets].map(([rootDir, target]) => [path.resolve(rootDir), target]),
    );
    this.extraRoots.clear();
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
    const { rootDir, filePath } = this.resolvePathWithinRoot(params.path);
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

      const workspace = await this.getWorkspace(rootDir);
      const content = await workspace.readText(filePath);
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
    const { rootDir, filePath } = this.resolvePathWithinRoot(params.path);
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

      const workspace = await this.getWorkspace(rootDir);
      const target = await workspace.resolve(filePath);
      const file = await workspace.openWritable(target, {
        mode: 0o666,
        assertBeforeMutation: () => assertControlAuthority(authority),
      });
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

  private resolvePathWithinRoot(rawPath: string): ResolvedFsPath {
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`Path must be absolute: ${rawPath}`);
    }
    const resolved = path.resolve(rawPath);
    if (isPathInside(this.rootDir, resolved)) {
      // Preserve symlink/.. traversal for filesystem resolution.
      return { rootDir: this.rootDir, filePath: rawPath };
    }
    // Pick the deepest containing additional root so nested roots resolve.
    const match = this.extraRootDirs
      .filter((dir) => isPathInside(dir, resolved))
      .toSorted((a, b) => b.length - a.length)[0];
    if (match === undefined) {
      throw new Error(`Path is outside allowed workspace roots: ${resolved}`);
    }
    // Rewrite synthetic skills-root reads onto the real skills dir so
    // follow-within-root containment holds.
    const skillTarget = this.skillTargets.get(match);
    if (skillTarget !== undefined) {
      const rel = path.relative(match, resolved);
      for (const layout of [".claude", ".agents"]) {
        const prefix = `${layout}${path.sep}skills`;
        if (rel === prefix || rel.startsWith(`${prefix}${path.sep}`)) {
          const rewritten = path.join(skillTarget, rel.slice(prefix.length + 1));
          return { rootDir: skillTarget, filePath: rewritten };
        }
      }
    }
    // Preserve symlink/.. traversal for filesystem resolution.
    return { rootDir: match, filePath: rawPath };
  }

  private getWorkspace(rootDir: string): Promise<Root> {
    if (rootDir === this.rootDir) {
      return (this.workspace ??= this.openRoot(rootDir));
    }
    let workspace = this.extraRoots.get(rootDir);
    if (workspace === undefined) {
      workspace = this.openRoot(rootDir);
      this.extraRoots.set(rootDir, workspace);
    }
    return workspace;
  }

  private openRoot(rootDir: string): Promise<Root> {
    return root(rootDir, {
      symlinks: "follow-within-root",
      hardlinks: "allow",
      maxBytes: Infinity,
    });
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
