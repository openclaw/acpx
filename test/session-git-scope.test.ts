import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { findGitRepositoryRoot, findSessionByDirectoryWalk } from "../src/session/persistence.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const agentCommand = "unused-synthetic-scope-agent";

async function saveSession(home: string, id: string, cwd: string, name?: string) {
  await writeSessionRecordFile(
    home,
    makeSessionRecord(
      {
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand,
        cwd,
        ...(name === undefined ? {} : { name }),
      },
      { defaultName: false, defaultAcpx: false },
    ),
  );
}

async function routedSession(cwd: string, name?: string) {
  return await findSessionByDirectoryWalk({
    agentCommand,
    cwd,
    name,
    boundary: findGitRepositoryRoot(cwd) ?? cwd,
  });
}

for (const marker of ["directory", "absolute-gitfile", "relative-gitfile"] as const) {
  test(`directory routing includes its ${marker} root and prefers a nearer saved scope`, async () => {
    await withTempHome("acpx-git-scope-", async (home) => {
      const root = path.join(home, "working tree");
      const nearer = path.join(root, "packages");
      const cwd = path.join(nearer, "app");
      const metadata = path.join(home, "git metadata", "worktrees", "fixture");
      await fs.mkdir(cwd, { recursive: true });
      if (marker === "directory") {
        await fs.mkdir(path.join(root, ".git"));
      } else {
        await fs.mkdir(metadata, { recursive: true });
        const target = marker === "absolute-gitfile" ? metadata : path.relative(root, metadata);
        await fs.writeFile(path.join(root, ".git"), `gitdir: ${target}\n`, "utf8");
      }

      await saveSession(home, "root-session", root);
      assert.equal(findGitRepositoryRoot(root), root);
      assert.equal(findGitRepositoryRoot(cwd), root);
      assert.equal((await routedSession(cwd))?.acpxRecordId, "root-session");
      await saveSession(home, "nearer-session", nearer);
      assert.equal((await routedSession(cwd))?.acpxRecordId, "nearer-session");
      assert.equal((await routedSession(root))?.acpxRecordId, "root-session");
    });
  });
}

test("a nested gitfile repository does not borrow a session from the outer repository", async () => {
  await withTempHome("acpx-nested-git-scope-", async (home) => {
    const outer = path.join(home, "outer");
    const inner = path.join(outer, "modules", "inner");
    const cwd = path.join(inner, "src", "nested");
    const metadata = path.join(outer, ".git", "modules", "inner");
    await fs.mkdir(metadata, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      path.join(inner, ".git"),
      `gitdir: ${path.relative(inner, metadata)}\n`,
      "utf8",
    );
    await saveSession(home, "outer-default", outer);
    await saveSession(home, "outer-named", outer, "outer-only");
    await saveSession(home, "inner-default", inner);

    assert.equal(findGitRepositoryRoot(cwd), inner);
    assert.equal((await routedSession(cwd))?.acpxRecordId, "inner-default");
    assert.equal(await routedSession(cwd, "outer-only"), undefined);
    assert.equal((await routedSession(outer, "outer-only"))?.acpxRecordId, "outer-named");
  });
});

test("directory routing outside a repository remains limited to exact cwd", async () => {
  await withTempHome("acpx-no-git-scope-", async (home) => {
    const parent = path.join(home, "workspace");
    const cwd = path.join(parent, "nested");
    await fs.mkdir(cwd, { recursive: true });
    await saveSession(home, "parent-session", parent);
    assert.equal(findGitRepositoryRoot(cwd), undefined);
    assert.equal(await routedSession(cwd), undefined);
    await saveSession(home, "exact-session", cwd);
    assert.equal((await routedSession(cwd))?.acpxRecordId, "exact-session");
  });
});

test("ordinary repository lookup reaches its root through a child named ..cache", async () => {
  await withTempHome("acpx-dotdot-name-scope-", async (home) => {
    const root = path.join(home, "repo");
    const cwd = path.join(root, "..cache", "src");
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await saveSession(home, "root-session", root);
    const boundary = findGitRepositoryRoot(cwd);
    assert.equal(boundary, root);
    assert.equal(
      (await findSessionByDirectoryWalk({ agentCommand, cwd, boundary }))?.acpxRecordId,
      "root-session",
    );
  });
});

test("a boundary outside the starting subtree still permits only exact-cwd lookup", async () => {
  await withTempHome("acpx-outside-boundary-scope-", async (home) => {
    const boundary = path.join(home, "repo");
    const outsideParent = path.join(home, "outside");
    const cwd = path.join(outsideParent, "nested");
    await fs.mkdir(path.join(boundary, ".git"), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await saveSession(home, "outside-parent-session", outsideParent);
    assert.equal(await findSessionByDirectoryWalk({ agentCommand, cwd, boundary }), undefined);
    await saveSession(home, "exact-session", cwd);
    assert.equal(
      (await findSessionByDirectoryWalk({ agentCommand, cwd, boundary }))?.acpxRecordId,
      "exact-session",
    );
  });
});
