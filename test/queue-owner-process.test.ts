import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildQueueOwnerArgOverride,
  queueOwnerRuntimeOptionsFromSend,
  resolveQueueOwnerSpawnArgs,
  sanitizeQueueOwnerExecArgv,
  writeQueueOwnerPayloadFile,
} from "../src/cli/session/queue-owner-process.js";
import { sessionControlTestInternals } from "../src/cli/session/session-control.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acpx-queue-owner-path-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveQueueOwnerSpawnArgs", () => {
  it("prefers ACPX_QUEUE_OWNER_ARGS when provided", () => {
    const previous = process.env.ACPX_QUEUE_OWNER_ARGS;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([
      "--import",
      "tsx",
      "src/cli.ts",
      "__queue-owner",
    ]);
    try {
      const args = resolveQueueOwnerSpawnArgs(["node", "ignored.js"]);
      assert.deepEqual(args, ["--import", "tsx", "src/cli.ts", "__queue-owner"]);
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previous;
      }
    }
  });

  it("returns <real cli path> and __queue-owner", async () => {
    await withTempDir(async (dir) => {
      const cliFile = path.join(dir, "cli.js");
      const cliLink = path.join(dir, "acpx-link.js");
      await writeFile(cliFile, "// stub\n", "utf8");
      await symlink(cliFile, cliLink);

      const args = resolveQueueOwnerSpawnArgs(["node", cliLink]);
      assert.deepEqual(args, [realpathSync(cliLink), "__queue-owner"]);
    });
  });

  it("throws when argv lacks an entry path", () => {
    assert.throws(() => resolveQueueOwnerSpawnArgs(["node"]), {
      message: "acpx self-spawn failed: missing CLI entry path",
    });
  });
});

describe("sanitizeQueueOwnerExecArgv", () => {
  it("drops test runner coverage flags but keeps loader args", () => {
    assert.deepEqual(
      sanitizeQueueOwnerExecArgv([
        "--experimental-test-coverage",
        "--test",
        "--test-name-pattern",
        "flow",
        "--import",
        "tsx",
        "--loader",
        "custom-loader",
      ]),
      ["--import", "tsx", "--loader", "custom-loader"],
    );
  });

  it("drops debugger flags from queue-owner exec args", () => {
    assert.deepEqual(
      sanitizeQueueOwnerExecArgv([
        "--inspect-brk=9229",
        "--inspect-port",
        "9230",
        "--debug-port=9231",
        "--import",
        "tsx",
      ]),
      ["--import", "tsx"],
    );
  });
});

describe("buildQueueOwnerArgOverride", () => {
  it("returns null when no loader args remain after sanitization", () => {
    assert.equal(
      buildQueueOwnerArgOverride("/tmp/cli.js", [
        "--experimental-test-coverage",
        "--test",
        "--test-name-pattern",
        "flow",
      ]),
      null,
    );
  });

  it("returns a serialized override when loader args are required", () => {
    assert.equal(
      buildQueueOwnerArgOverride("/tmp/cli.js", ["--import", "tsx"]),
      JSON.stringify(["--import", "tsx", "/tmp/cli.js", "__queue-owner"]),
    );
  });
});

describe("writeQueueOwnerPayloadFile", () => {
  it("writes queue owner payloads to a private temp file", async () => {
    const payloadPath = writeQueueOwnerPayloadFile('{"sessionId":"session-1"}');

    try {
      assert.equal(await fs.readFile(payloadPath, "utf8"), '{"sessionId":"session-1"}');
      if (process.platform !== "win32") {
        const mode = (await fs.stat(payloadPath)).mode & 0o777;
        assert.equal(mode, 0o600);
      }
    } finally {
      await fs.rm(path.dirname(payloadPath), { recursive: true, force: true });
    }
  });
});

describe("queueOwnerRuntimeOptionsFromSend", () => {
  it("preserves terminal capability preference", () => {
    const options = queueOwnerRuntimeOptionsFromSend({
      sessionId: "session-1",
      permissionMode: "approve-reads",
      terminal: false,
    });

    assert.equal(options.terminal, false);
  });
});

describe("session process command parsing", () => {
  it("reads quoted executable paths from saved agent commands", () => {
    assert.equal(
      sessionControlTestInternals.firstAgentCommandToken(
        '"/Applications/My Agent.app/Contents/MacOS/agent" --profile x',
      ),
      "/Applications/My Agent.app/Contents/MacOS/agent",
    );
  });

  it("preserves quoted executable paths in process-list fallbacks", () => {
    assert.deepEqual(
      sessionControlTestInternals.splitCommandLineLike(
        '"/Applications/My Agent.app/Contents/MacOS/agent" --profile "with spaces"',
      ),
      ["/Applications/My Agent.app/Contents/MacOS/agent", "--profile", "with spaces"],
    );
  });
});
