import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { root, type Root } from "@openclaw/fs-safe/root";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import { FileSystemHandlers } from "../src/filesystem.js";
import type { ClientOperation } from "../src/types.js";

for (const rootSpelling of ["temporary", "canonical", "symlink"] as const) {
  for (const operation of ["read", "write"] as const) {
    test(
      `${operation}TextFile preserves symlink-parent traversal with a ${rootSpelling} cwd`,
      { skip: process.platform === "win32" },
      async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-parent-"));
        try {
          const workspace = path.join(directory, "workspace");
          await fs.mkdir(path.join(workspace, "nested", "child"), { recursive: true });
          await fs.symlink(path.join(workspace, "nested", "child"), path.join(workspace, "alias"));
          const rootTarget = path.join(workspace, "target.txt");
          const nestedTarget = path.join(workspace, "nested", "target.txt");
          await fs.writeFile(rootTarget, "unrelated root sentinel");
          await fs.writeFile(nestedTarget, "requested nested sentinel");
          let cwd = workspace;
          if (rootSpelling === "canonical") {
            cwd = await fs.realpath(workspace);
          } else if (rootSpelling === "symlink") {
            cwd = path.join(directory, "cwd-alias");
            await fs.symlink(workspace, cwd);
          }
          // path.join would erase the traversal before it reaches the handler.
          const requested = `${cwd}/alias/../target.txt`;
          const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
          if (operation === "read") {
            const result = await handlers.readTextFile({ sessionId: "synthetic", path: requested });
            assert.equal(result.content, await fs.readFile(requested, "utf8"));
            assert.equal(result.content, "requested nested sentinel");
          } else {
            await handlers.writeTextFile({
              sessionId: "synthetic",
              path: requested,
              content: "updated nested target",
            });
            assert.equal(await fs.readFile(nestedTarget, "utf8"), "updated nested target");
          }
          assert.equal(await fs.readFile(rootTarget, "utf8"), "unrelated root sentinel");
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
}

test("file handlers retain ordinary parent traversal without a symlink", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-parent-control-"));
  try {
    await fs.mkdir(path.join(cwd, "nested"));
    const target = path.join(cwd, "target.txt");
    await fs.writeFile(target, "root target");
    const requested = `${cwd}${path.sep}nested${path.sep}..${path.sep}target.txt`;
    const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
    assert.equal(
      (await handlers.readTextFile({ sessionId: "synthetic", path: requested })).content,
      "root target",
    );
    await handlers.writeTextFile({
      sessionId: "synthetic",
      path: requested,
      content: "updated root",
    });
    assert.equal(await fs.readFile(target, "utf8"), "updated root");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

for (const existing of [true, false]) {
  test(`writeTextFile checks authority at native ${existing ? "truncation" : "parent creation"}`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-write-authority-"));
    try {
      const file = path.join(cwd, existing ? "sentinel.txt" : "new/nested/file.txt");
      if (existing) {
        await fs.writeFile(file, "keep these bytes");
      }
      const controller = new AbortController();
      const revoked = new Error("write authority revoked");
      const workspace = await root(cwd, { assertBeforeMutation: () => controller.abort(revoked) });
      const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
      (handlers as unknown as { workspace: Promise<Root> }).workspace = Promise.resolve(workspace);
      await assert.rejects(
        handlers.writeTextFile(
          { sessionId: "synthetic", path: file, content: "must not write" },
          { signal: controller.signal },
        ),
        (error) => error === revoked,
      );
      if (existing) {
        assert.equal(await fs.readFile(file, "utf8"), "keep these bytes");
      } else {
        await assert.rejects(fs.access(path.join(cwd, "new")), { code: "ENOENT" });
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

test("writeTextFile closes an admitted handle without writing after authority expires", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-write-handle-authority-"));
  try {
    const file = path.join(cwd, "sentinel.txt");
    await fs.writeFile(file, "already dispatched truncation is allowed");
    const controller = new AbortController();
    const workspace = await root(cwd);
    const openWritable = workspace.openWritable.bind(workspace);
    let opened: Awaited<ReturnType<Root["openWritable"]>> | undefined;
    workspace.openWritable = async (...args) => {
      opened = await openWritable(...args);
      controller.abort(new Error("expired after open"));
      return opened;
    };
    const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
    (handlers as unknown as { workspace: Promise<Root> }).workspace = Promise.resolve(workspace);
    await assert.rejects(
      handlers.writeTextFile(
        { sessionId: "synthetic", path: file, content: "must not write" },
        { signal: controller.signal },
      ),
      /expired after open/u,
    );
    assert.equal(await fs.readFile(file, "utf8"), "");
    assert(opened);
    await assert.rejects(opened.handle.stat(), { code: "EBADF" });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

for (const kind of ["file", "directory"] as const) {
  test(
    `ACP file handlers reject outside ${kind} symlinks before reading or writing`,
    { skip: process.platform === "win32" },
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-boundary-"));
      try {
        const cwd = path.join(directory, "workspace");
        const outside = path.join(directory, "outside");
        await fs.mkdir(cwd);
        await fs.mkdir(outside);
        const target = path.join(outside, "target.txt");
        await fs.writeFile(target, "outside remains unchanged");
        const alias = path.join(cwd, "alias");
        await fs.symlink(kind === "file" ? target : outside, alias);
        const requested = kind === "file" ? alias : path.join(alias, "target.txt");
        const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
        await assert.rejects(handlers.readTextFile({ sessionId: "synthetic", path: requested }));
        await assert.rejects(
          handlers.writeTextFile({
            sessionId: "synthetic",
            path: requested,
            content: "must not write",
          }),
        );
        if (kind === "directory") {
          await assert.rejects(
            handlers.writeTextFile({
              sessionId: "synthetic",
              path: path.join(alias, "new", "file.txt"),
              content: "must not create",
            }),
          );
        }
        assert.equal(await fs.readFile(target, "utf8"), "outside remains unchanged");
        assert.deepEqual(await fs.readdir(outside), ["target.txt"]);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test(
  "ACP file handlers preserve contained aliases, filenames, and executable in-place writes",
  { skip: process.platform === "win32" },
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-compatible-"));
    try {
      const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
      for (const name of ["..notes", "~/notes", "c:notes"]) {
        const file = path.join(cwd, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await handlers.writeTextFile({ sessionId: "synthetic", path: file, content: name });
        assert.equal(
          (await handlers.readTextFile({ sessionId: "synthetic", path: file })).content,
          name,
        );
      }
      const target = path.join(cwd, "script.sh");
      await fs.writeFile(target, "long original script", { mode: 0o755 });
      await fs.chmod(target, 0o755);
      const before = await fs.stat(target);
      const alias = path.join(cwd, "script-alias");
      await fs.symlink(target, alias);
      await handlers.writeTextFile({ sessionId: "synthetic", path: alias, content: "short" });
      const after = await fs.stat(target);
      assert.equal(await fs.readFile(target, "utf8"), "short");
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode & 0o777, 0o755);
      assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
      const hardlink = path.join(cwd, "hardlink");
      await fs.link(target, hardlink);
      assert.equal(
        (await handlers.readTextFile({ sessionId: "synthetic", path: hardlink })).content,
        "short",
      );
      await assert.rejects(
        handlers.writeTextFile({ sessionId: "synthetic", path: hardlink, content: "refused" }),
      );
      assert.equal(await fs.readFile(target, "utf8"), "short");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

test("ACP file reads preserve content larger than fs-safe's default limit", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-large-"));
  try {
    const content = "x".repeat(16 * 1024 * 1024 + 1);
    const file = path.join(cwd, "large.txt");
    await fs.writeFile(file, content);
    const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-reads" });
    assert.equal(
      (await handlers.readTextFile({ sessionId: "synthetic", path: file })).content,
      content,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

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
      /outside allowed workspace roots/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("additional roots grant fs access outside cwd while other paths stay blocked", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-roots-"));
  try {
    const cwd = path.join(tmp, "workspace");
    const extra = path.join(tmp, "extra");
    const other = path.join(tmp, "other");
    await fs.mkdir(cwd);
    await fs.mkdir(extra);
    await fs.mkdir(other);
    await fs.writeFile(path.join(extra, "note.txt"), "extra content");

    const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
    // Before granting, the extra root is outside the allowed subtree.
    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: path.join(extra, "note.txt"),
      }),
      /outside allowed workspace roots/,
    );

    handlers.setAdditionalRoots([extra]);
    const read = await handlers.readTextFile({
      sessionId: "session-1",
      path: path.join(extra, "note.txt"),
    });
    assert.equal(read.content, "extra content");

    await handlers.writeTextFile({
      sessionId: "session-1",
      path: path.join(extra, "written.txt"),
      content: "written",
    });
    assert.equal(await fs.readFile(path.join(extra, "written.txt"), "utf8"), "written");

    // Paths outside every granted root remain blocked.
    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: path.join(other, "nope.txt"),
      }),
      /outside allowed workspace roots/,
    );
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

test(
  "ACP file handlers serve skills-dir reads through the synthetic root and reject escapes",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-skills-"));
    try {
      const cwd = path.join(directory, "workspace");
      const skillsDir = path.join(directory, "skills");
      const syntheticRoot = path.join(directory, "synthetic-root");
      const sibling = path.join(directory, "sibling");
      await fs.mkdir(cwd);
      await fs.mkdir(path.join(skillsDir, "demo-skill"), { recursive: true });
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(skillsDir, "demo-skill", "SKILL.md"), "skill body");
      await fs.writeFile(path.join(sibling, "secret.txt"), "sibling secret");
      // The synthetic root is never opened on disk: resolvePathWithinRoot
      // rewrites .claude/skills and .agents/skills reads onto the target.

      const handlers = new FileSystemHandlers({ cwd, permissionMode: "approve-all" });
      handlers.setAdditionalRoots([syntheticRoot], new Map([[syntheticRoot, skillsDir]]));

      // Reads through both synthetic links land on the real skills dir.
      for (const layout of [".claude", ".agents"]) {
        const content = await handlers.readTextFile({
          sessionId: "synthetic",
          path: path.join(syntheticRoot, layout, "skills", "demo-skill", "SKILL.md"),
        });
        assert.equal(content.content, "skill body");
      }

      // The synthetic root itself is not a real tree: a path that escapes the
      // skills links must not reach sibling dirs.
      await assert.rejects(
        handlers.readTextFile({
          sessionId: "synthetic",
          path: path.join(syntheticRoot, "..", "sibling", "secret.txt"),
        }),
      );
      // A symlink inside the skills dir pointing outside is still rejected by
      // follow-within-root on the target.
      await fs.symlink(sibling, path.join(skillsDir, "escape"));
      await assert.rejects(
        handlers.readTextFile({
          sessionId: "synthetic",
          path: path.join(syntheticRoot, ".claude", "skills", "escape", "secret.txt"),
        }),
      );
      // Writes through the synthetic link land on the real skills dir.
      await handlers.writeTextFile({
        sessionId: "synthetic",
        path: path.join(syntheticRoot, ".claude", "skills", "demo-skill", "notes.txt"),
        content: "written through link",
      });
      assert.equal(
        await fs.readFile(path.join(skillsDir, "demo-skill", "notes.txt"), "utf8"),
        "written through link",
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
