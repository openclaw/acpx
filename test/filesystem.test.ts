import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import { FileSystemHandlers } from "../src/filesystem.js";
import type { ClientOperation } from "../src/types.js";

test("readTextFile respects line/limit and logs operations", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const filePath = path.join(tmp, "notes.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree\nfour\n", "utf8");

    const ops: ClientOperation[] = [];
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
      onOperation: (operation) => ops.push(operation),
    });

    const response = await handlers.readTextFile({
      sessionId: "session-1",
      path: filePath,
      line: 2,
      limit: 2,
    });

    assert.equal(response.content, "two\nthree");
    assert.equal(
      ops.some(
        (operation) => operation.method === "fs/read_text_file" && operation.status === "completed",
      ),
      true,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readTextFile is denied in deny-all mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const filePath = path.join(tmp, "notes.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "deny-all",
    });

    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: filePath,
      }),
      /Permission denied for fs\/read_text_file/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile prompts in approve-reads mode and can deny", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    let confirmCalls = 0;
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
      confirmWrite: async () => {
        confirmCalls += 1;
        return false;
      },
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        path: path.join(tmp, "blocked.txt"),
        content: "blocked",
      }),
      /Permission denied for fs\/write_text_file/,
    );
    assert.equal(confirmCalls, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile fails when prompt is unavailable and policy is fail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        path: path.join(tmp, "blocked.txt"),
        content: "blocked",
      }),
      PermissionPromptUnavailableError,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile blocks paths outside cwd subtree", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const outside = path.resolve(tmp, "..", "outside.txt");
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        path: outside,
        content: "nope",
      }),
      /outside allowed cwd subtree/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readTextFile blocks reads through a symlink pointing outside cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const sandbox = path.join(tmp, "sandbox");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(sandbox, "link.txt"));

    const handlers = new FileSystemHandlers({
      cwd: sandbox,
      permissionMode: "approve-all",
    });

    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: path.join(sandbox, "link.txt"),
      }),
      /outside allowed cwd subtree/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile blocks new files under a symlinked directory pointing outside cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const sandbox = path.join(tmp, "sandbox");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(sandbox, "escape"));

    const handlers = new FileSystemHandlers({
      cwd: sandbox,
      permissionMode: "approve-all",
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        // The leaf does not exist, so containment must be decided from the
        // resolved parent rather than the lexical path.
        path: path.join(sandbox, "escape", "pwned.txt"),
        content: "nope",
      }),
      /outside allowed cwd subtree/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readTextFile allows existing files when cwd is itself a symlink", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    // The link path is deliberately shorter than its canonical target, which is
    // the shape a symlinked cwd takes in practice (macOS /tmp -> /private/tmp).
    const realRoot = path.join(tmp, "a", "b", "c", "d", "project");
    const linkedRoot = path.join(tmp, "w");
    await fs.mkdir(realRoot, { recursive: true });
    await fs.symlink(realRoot, linkedRoot);
    await fs.writeFile(path.join(realRoot, "notes.txt"), "hello", "utf8");

    const handlers = new FileSystemHandlers({
      cwd: linkedRoot,
      permissionMode: "approve-all",
    });

    const response = await handlers.readTextFile({
      sessionId: "session-1",
      path: path.join(linkedRoot, "notes.txt"),
    });

    assert.equal(response.content, "hello");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile allows new files when cwd is itself a symlink", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const realRoot = path.join(tmp, "a", "b", "c", "d", "project");
    const linkedRoot = path.join(tmp, "w");
    await fs.mkdir(realRoot, { recursive: true });
    await fs.symlink(realRoot, linkedRoot);

    const handlers = new FileSystemHandlers({
      cwd: linkedRoot,
      permissionMode: "approve-all",
    });

    // Non-existent leaf under a symlinked cwd: the ancestor walk has to run
    // even though the lexical cwd is shorter than its canonical target.
    await handlers.writeTextFile({
      sessionId: "session-1",
      path: path.join(linkedRoot, "new.txt"),
      content: "written",
    });

    assert.equal(await fs.readFile(path.join(realRoot, "new.txt"), "utf8"), "written");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readTextFile requires absolute paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
    });

    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: "relative.txt",
      }),
      /Path must be absolute/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
