import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPromptTurn } from "../src/runtime/engine/prompt-turn.js";
import {
  createSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import {
  extractAgentMessageChunkText,
  extractJsonRpcId,
  parseJsonRpcOutputLines,
} from "./jsonrpc-test-helpers.js";
import { queuePaths } from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const FLOW_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/flow-branch.flow.js", import.meta.url));
const FLOW_SHELL_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-shell.flow.js", import.meta.url),
);
const FLOW_INTERRUPT_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-interrupt.flow.js", import.meta.url),
);
const FLOW_ACP_DISCONNECT_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-acp-disconnect.flow.js", import.meta.url),
);
const FLOW_WAIT_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-wait.flow.js", import.meta.url),
);
const FLOW_WORKDIR_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-workdir.flow.js", import.meta.url),
);
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const LOAD_CAPABLE_MOCK_AGENT_COMMAND = `${MOCK_AGENT_COMMAND} --supports-load-session`;

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CliRunOptions = {
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
};

test("integration: exec echo baseline", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in cursor agent resolves to cursor-agent acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-cursor-"));

    try {
      await writeFakeCursorAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "cursor", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run executes multiple ACP steps in one session and branches", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "1",
          "flow",
          "run",
          FLOW_FIXTURE_PATH,
          "--input-json",
          JSON.stringify({ next: "yes_path" }),
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: Record<string, unknown>;
        sessionBindings?: Record<string, { acpxRecordId: string }>;
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.outputs?.yes_path, { ok: true });
      assert.equal(payload.outputs?.no_path, undefined);
      assert.equal(
        Object.keys(payload.sessionBindings ?? {}).length,
        1,
        JSON.stringify(payload, null, 2),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run supports dynamic ACP working directories", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "1",
          "flow",
          "run",
          FLOW_WORKDIR_FIXTURE_PATH,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          prepare?: { workdir: string };
          finalize?: { cwd: string };
        };
        sessionBindings?: Record<string, { cwd: string }>;
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      const workdir = payload.outputs?.prepare?.workdir;
      const finalCwd = payload.outputs?.finalize?.cwd;
      assert.equal(typeof workdir, "string");
      assert.equal(typeof finalCwd, "string");
      assert.equal(await fs.realpath(String(finalCwd)), await fs.realpath(String(workdir)));
      const bindings = Object.values(payload.sessionBindings ?? {});
      assert.equal(bindings.length, 1);
      assert.equal(await fs.realpath(bindings[0]?.cwd ?? ""), await fs.realpath(String(workdir)));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run executes function and shell actions from --input-file", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const inputPath = path.join(cwd, "input.json");

    try {
      await fs.writeFile(inputPath, JSON.stringify({ text: "smoke" }), "utf8");

      const result = await runCli(
        [
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "flow",
          "run",
          FLOW_SHELL_FIXTURE_PATH,
          "--input-file",
          inputPath,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          prepare?: { text: string };
          finalize?: { value: string; cwd: string };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.equal(payload.outputs?.prepare?.text, "SMOKE");
      assert.equal(payload.outputs?.finalize?.value, "SMOKE");
      assert.equal(
        await fs.realpath(String(payload.outputs?.finalize?.cwd ?? "")),
        await fs.realpath(cwd),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run finalizes interrupted bundles on SIGHUP", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "flow",
          "run",
          FLOW_INTERRUPT_FIXTURE_PATH,
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const outputRoot = path.join(homeDir, ".acpx", "flows", "runs");
      const runDir = await waitForFlowRunDir(outputRoot, "fixture-interrupt");
      await waitFor(async () => {
        const state = await readFlowRunJson(runDir);
        if (state.currentNode === "slow" && state.status === "running") {
          return state;
        }
        return null;
      }, 5_000);

      child.kill("SIGHUP");
      const result = await awaitChildClose(child);
      assert.equal(result.code, 130, stderr);

      const finalState = await waitFor(async () => {
        const state = await readFlowRunJson(runDir);
        if (state.status === "failed" && state.error === "Interrupted") {
          return state;
        }
        return null;
      }, 5_000);

      assert.equal(finalState.currentNode, "slow");
      assert.equal(finalState.currentAttemptId, "slow#1");
      assert.match(String(finalState.statusDetail ?? ""), /Failed in slow: Interrupted/);

      const traceEvents = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; payload?: { error?: string } });
      const finalEvent = traceEvents.at(-1);
      assert.equal(finalEvent?.type, "run_failed");
      assert.equal(finalEvent?.payload?.error, "Interrupted");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run fails ACP nodes promptly when the agent disconnects mid-prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "flow",
          "run",
          FLOW_ACP_DISCONNECT_FIXTURE_PATH,
        ],
        homeDir,
        {
          cwd,
          timeoutMs: 5_000,
        },
      );

      const outputRoot = path.join(homeDir, ".acpx", "flows", "runs");
      const runDir = await waitForFlowRunDir(outputRoot, "fixture-acp-disconnect");
      assert.notEqual(result.code, 0, result.stdout);

      const finalState = await waitFor(async () => {
        const state = await readFlowRunJson(runDir).catch(() => null);
        return state && state.status === "failed" ? state : null;
      }, 5_000);

      assert.equal(finalState.status, "failed");
      assert.equal(
        (finalState.results as Record<string, { outcome?: string }>).slow?.outcome,
        "failed",
      );
      assert.match(
        String(
          (finalState.results as Record<string, { error?: string }>).slow?.error ?? result.stderr,
        ),
        /agent disconnected/i,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run fails fast when a flow requires an explicit approve-all grant", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-"));
    const flowPath = path.join(flowDir, "requires-approve-all.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { compute, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "requires-explicit-approve-all",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow writes to the repo and needs full ACP permissions.",',
          "  },",
          '  startAt: "done",',
          "  nodes: {",
          "    done: compute({",
          "      run: () => ({ ok: true }),",
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "flow", "run", flowPath],
        homeDir,
      );

      assert.equal(result.code, 2);
      assert.match(result.stderr, /requires an explicit approve-all grant/i);
      assert.match(result.stderr, /Rerun with --approve-all/i);
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run requires defineFlow before permission gating", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-"));
    const flowPath = path.join(flowDir, "plain-export.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          "export default {",
          '  name: "plain-export",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow writes to the repo and needs full ACP permissions.",',
          "  },",
          '  startAt: "done",',
          "  nodes: {",
          '    done: { nodeType: "compute", run: () => ({ ok: true }) },',
          "  },",
          "  edges: [],",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(["--cwd", cwd, "flow", "run", flowPath], homeDir);

      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /Flow module must export default defineFlow\(\{\.\.\.\}\) from "acpx\/flows"/,
      );
      assert.doesNotMatch(result.stderr, /requires an explicit approve-all grant/i);
      assert.doesNotMatch(result.stderr, /Rerun with --approve-all/i);
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run preserves approve-all through persistent ACP writes", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-write-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-write-"));
    const flowPath = path.join(flowDir, "write-through-session.flow.ts");
    const writePath = path.join(cwd, "flow-write.txt");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { acp, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "write-through-session",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow writes files through ACP.",',
          "  },",
          '  startAt: "write_file",',
          "  nodes: {",
          "    write_file: acp({",
          `      prompt: () => ${JSON.stringify(`write ${writePath} hello`)},`,
          "      parse: (text) => ({ reply: text }),",
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        [
          "--agent",
          LOAD_CAPABLE_MOCK_AGENT_COMMAND,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--ttl",
          "1",
          "flow",
          "run",
          flowPath,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          write_file?: {
            reply?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.match(payload.outputs?.write_file?.reply ?? "", /wrote /i);
      assert.equal(await fs.readFile(writePath, "utf8"), "hello");
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test('integration: flow run resolves "acpx/flows" imports for external flow files', async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-import-"));
    const flowPath = path.join(flowDir, "external.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { compute, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "external-flow-import",',
          '  startAt: "done",',
          "  nodes: {",
          "    done: compute({",
          '      run: () => ({ ok: true, source: "external" }),',
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "flow", "run", flowPath],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          done?: {
            ok?: boolean;
            source?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.outputs?.done, {
        ok: true,
        source: "external",
      });
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run supports staged defineFlow assembly in external modules", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-staged-"));
    const flowPath = path.join(flowDir, "staged.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { compute, defineFlow } from "acpx/flows";',
          "",
          "const nodes = {};",
          "const flow = defineFlow({",
          '  name: "staged-flow-import",',
          '  startAt: "done",',
          "  nodes,",
          "  edges: [],",
          "});",
          "",
          "nodes.done = compute({",
          '  run: () => ({ ok: true, source: "staged" }),',
          "});",
          "",
          "export default flow;",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "flow", "run", flowPath],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          done?: {
            ok?: boolean;
            source?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.outputs?.done, {
        ok: true,
        source: "staged",
      });
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run reports waiting checkpoints in json mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "flow",
          "run",
          FLOW_WAIT_FIXTURE_PATH,
          "--input-json",
          JSON.stringify({ ticket: "pr-174" }),
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        waitingOn?: string;
        outputs?: {
          prepare?: { ticket: string };
          wait_for_human?: { checkpoint: string; summary: string };
          unreachable?: unknown;
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "waiting");
      assert.equal(payload.waitingOn, "wait_for_human");
      assert.equal(payload.outputs?.prepare?.ticket, "pr-174");
      assert.equal(payload.outputs?.wait_for_human?.checkpoint, "wait_for_human");
      assert.equal(payload.outputs?.wait_for_human?.summary, "review pr-174");
      assert.equal(payload.outputs?.unreachable, undefined);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in droid agent resolves to droid exec --output-format acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-droid-"));

    try {
      await writeFakeDroidAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "droid", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: factory-droid alias resolves to droid exec --output-format acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-droid-"));

    try {
      await writeFakeDroidAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "factory-droid", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in iflow agent resolves to iflow --experimental-acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-iflow-"));

    try {
      await writeFakeIflowAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "iflow", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in qoder agent resolves to qodercli --acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-qoder-"));

    try {
      await writeFakeQoderAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "qoder", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: qoder session reuse preserves persisted startup flags", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-qoder-"));
    const argLogPath = path.join(fakeBinDir, "qoder-args.log");

    try {
      await writeFakeQoderAgent(fakeBinDir, argLogPath);
      const { createSession } = await import("../src/session/session.js");
      const { runSessionSetModeDirect } = await import("../src/cli/session/prompt-runner.js");
      const previousHome = process.env.HOME;
      const previousPath = process.env.PATH;
      process.env.HOME = homeDir;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`;

      try {
        const record = await createSession({
          agentCommand: "qodercli --acp",
          cwd,
          permissionMode: "approve-reads",
          timeoutMs: 10_000,
          sessionOptions: {
            allowedTools: ["Read", "Grep"],
            maxTurns: 4,
          },
        });

        const result = await runSessionSetModeDirect({
          sessionRecordId: record.acpxRecordId,
          modeId: "plan",
          timeoutMs: 10_000,
        });
        assert.equal(result.record.acpxRecordId, record.acpxRecordId);
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        process.env.PATH = previousPath;
      }

      const argLines = (await fs.readFile(argLogPath, "utf8"))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      assert.equal(
        argLines.length >= 2,
        true,
        `expected at least two qoder invocations:\n${argLines.join("\n")}`,
      );
      assert.equal(
        argLines.some(
          (line) =>
            line.includes("--acp") &&
            line.includes("--max-turns=4") &&
            line.includes("--allowed-tools=READ,GREP"),
        ),
        true,
        `expected persisted qoder flags in logged invocations:\n${argLines.join("\n")}`,
      );
      assert.equal(
        argLines.slice(-1)[0]?.includes("--allowed-tools=READ,GREP") ?? false,
        true,
        `expected reused prompt spawn to preserve allowed-tools:\n${argLines.join("\n")}`,
      );
      assert.equal(
        argLines.slice(-1)[0]?.includes("--max-turns=4") ?? false,
        true,
        `expected reused prompt spawn to preserve max-turns:\n${argLines.join("\n")}`,
      );
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec forwards model, allowed-tools, and max-turns in session/new _meta", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli([...baseAgentArgs(cwd), "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--model",
          "sonnet",
          "--allowed-tools",
          "Read,Grep",
          "--max-turns",
          "7",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const createRequest = payloads.find((payload) => payload.method === "session/new") as
        | { params?: { _meta?: unknown } }
        | undefined;
      assert(createRequest, result.stdout);
      assert.deepEqual(createRequest.params?._meta, {
        claudeCode: {
          options: {
            model: "sonnet",
            allowedTools: ["Read", "Grep"],
            maxTurns: 7,
          },
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --no-terminal disables advertised terminal capability", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--no-terminal", "exec", "echo hello"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const initializeRequest = payloads.find((payload) => payload.method === "initialize") as
        | { params?: { clientCapabilities?: { terminal?: unknown } } }
        | undefined;
      assert(initializeRequest, result.stdout);
      assert.equal(initializeRequest.params?.clientCapabilities?.terminal, false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model calls session/set_model when agent advertises models", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      const result = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "fast-model",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const setModelRequest = payloads.find((payload) => payload.method === "session/set_model") as
        | { params?: { modelId?: string } }
        | undefined;
      assert(setModelRequest, "expected session/set_model request in JSON-RPC output");
      assert.equal(setModelRequest.params?.modelId, "fast-model");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model skips session/set_model when agent does not advertise models", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--model", "sonnet", "exec", "echo hello"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);

      // _meta.claudeCode.options.model should still be sent
      const createRequest = payloads.find((payload) => payload.method === "session/new") as
        | { params?: { _meta?: Record<string, unknown> } }
        | undefined;
      assert(createRequest, "expected session/new request");
      assert.deepEqual((createRequest.params?._meta as Record<string, unknown>)?.claudeCode, {
        options: { model: "sonnet" },
      });

      // session/set_model should NOT be called
      const setModelRequest = payloads.find((payload) => payload.method === "session/set_model");
      assert.equal(setModelRequest, undefined, "session/set_model should not be called");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt --model updates existing session model before prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      const created = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "fast-model",
          "prompt",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const setModelRequest = payloads.find((payload) => payload.method === "session/set_model") as
        | { params?: { modelId?: string } }
        | undefined;
      assert(setModelRequest, "expected session/set_model before the persistent prompt");
      assert.equal(setModelRequest.params?.modelId, "fast-model");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model fails when session/set_model fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const failModelAgentCommand = `${MOCK_AGENT_COMMAND} --set-session-model-fails`;

    try {
      const result = await runCli(
        [
          "--agent",
          failModelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "quiet",
          "--model",
          "bad-model",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /setSessionModel failed|session\/set_model/i);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions new --model fails when session/set_model fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const failModelAgentCommand = `${MOCK_AGENT_COMMAND} --set-session-model-fails`;

    try {
      const result = await runCli(
        [
          "--agent",
          failModelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "bad-model",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.match(result.stderr, /setSessionModel failed|session\/set_model/i);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: set model routes through session/set_model and succeeds", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      // Create session
      const created = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Switch model mid-session via set command (uses session/set_model internally)
      const setResult = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "set",
          "model",
          "gpt-5.4",
        ],
        homeDir,
      );
      assert.equal(setResult.code, 0, setResult.stderr);
      const payload = JSON.parse(setResult.stdout.trim()) as {
        action?: string;
        modelId?: string;
      };
      assert.equal(payload.action, "model_set");
      assert.equal(payload.modelId, "gpt-5.4");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: set model rejects with clear error on ACP invalid params", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const invalidModelAgentCommand = `${MOCK_AGENT_COMMAND} --set-session-model-invalid-params`;

    try {
      // Create session
      const created = await runCli(
        ["--agent", invalidModelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Attempt model switch — should fail with enriched error
      const setResult = await runCli(
        [
          "--agent",
          invalidModelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "set",
          "model",
          "bad-model",
        ],
        homeDir,
      );
      assert.notEqual(setResult.code, 0, "expected non-zero exit");
      assert.match(setResult.stderr, /rejected session\/set_model/i);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: status shows model after session creation with --model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      // Create session with --model
      const created = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "gpt-5.4",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Check status JSON
      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);

      const statusPayload = JSON.parse(status.stdout.trim()) as {
        model?: string;
        mode?: string;
        availableModels?: string[];
      };
      assert.equal(statusPayload.model, "gpt-5.4");
      assert(Array.isArray(statusPayload.availableModels), "expected availableModels array");

      // Check status text
      const statusText = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "status"],
        homeDir,
      );
      assert.equal(statusText.code, 0, statusText.stderr);
      assert.match(statusText.stdout, /model: gpt-5\.4/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: status shows updated model after set model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      // Create session with --model
      const created = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "fast-model",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Switch model
      const setResult = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "set", "model", "gpt-5.4"],
        homeDir,
      );
      assert.equal(setResult.code, 0, setResult.stderr);

      // Check status JSON — should show updated model
      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);

      const statusPayload = JSON.parse(status.stdout.trim()) as { model?: string };
      assert.equal(statusPayload.model, "gpt-5.4");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: perf metrics capture writes ndjson records for CLI runs", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const metricsPath = path.join(homeDir, "perf", "metrics.ndjson");

    try {
      const result = await runCli([...baseExecArgs(cwd), "echo hello"], homeDir, {
        env: {
          ACPX_PERF_METRICS_FILE: metricsPath,
        },
      });
      assert.equal(result.code, 0, result.stderr);

      const payload = await fs.readFile(metricsPath, "utf8");
      const records = payload
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { role?: string; metrics?: { timings?: Record<string, unknown> } },
        );

      assert.equal(records.length >= 1, true);
      assert.equal(
        records.some((record) => record.role === "cli"),
        true,
      );
      assert.equal(
        records.some(
          (record) =>
            record.metrics &&
            typeof record.metrics === "object" &&
            record.metrics.timings &&
            Object.keys(record.metrics.timings).length > 0,
        ),
        true,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: perf metrics capture checkpoints queue-owner turns before owner exit", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const metricsPath = path.join(homeDir, "perf", "metrics.ndjson");

    try {
      const created = await runCli([...baseAgentArgs(cwd), "sessions", "new"], homeDir, {
        env: {
          ACPX_PERF_METRICS_FILE: metricsPath,
        },
      });
      assert.equal(created.code, 0, created.stderr);

      const prompted = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "--ttl", "5", "prompt", "echo warm"],
        homeDir,
        {
          env: {
            ACPX_PERF_METRICS_FILE: metricsPath,
          },
        },
      );
      assert.equal(prompted.code, 0, prompted.stderr);
      assert.match(prompted.stdout, /warm/);

      const queueOwnerRecord = await waitForValue(async () => {
        const records = await readPerfRecords(metricsPath);
        return records.find(
          (record) =>
            record.role === "queue_owner" &&
            record.reason === "checkpoint" &&
            typeof record.metrics === "object" &&
            typeof record.metrics?.timings === "object" &&
            Object.keys(record.metrics.timings ?? {}).length > 0,
        );
      });
      assert(queueOwnerRecord, "expected queue owner checkpoint record before owner exit");
      assert.equal(readPerfTimingCount(queueOwnerRecord, "session.write_record"), 1);

      const status = await runCli([...baseAgentArgs(cwd), "--format", "json", "status"], homeDir);
      assert.equal(status.code, 0, status.stderr);
      const statusPayload = JSON.parse(status.stdout.trim()) as { status?: string };
      assert.equal(statusPayload.status, "alive");

      const closed = await runCli([...baseAgentArgs(cwd), "sessions", "close"], homeDir);
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: perf report tolerates malformed lines and keeps role and gauge summaries", async () => {
  const metricsPath = path.join(os.tmpdir(), `acpx-perf-report-${Date.now()}.ndjson`);

  try {
    await fs.writeFile(
      metricsPath,
      [
        JSON.stringify({
          role: "cli",
          metrics: {
            counters: {
              sample: 1,
            },
            timings: {
              "runtime.exec.start": {
                count: 1,
                totalMs: 12.5,
                maxMs: 12.5,
              },
            },
          },
        }),
        "not-json",
        JSON.stringify({
          role: "queue_owner",
          metrics: {
            gauges: {
              "queue.owner.depth": 2,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await runPerfReport(metricsPath);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      droppedLines?: number;
      gauges?: Record<string, unknown>;
      byRole?: Record<string, { gauges?: Record<string, unknown>; timings?: unknown[] }>;
    };
    assert.equal(payload.droppedLines, 1);
    assert.equal(typeof payload.gauges?.["queue.owner.depth"], "object");
    assert.equal(Array.isArray(payload.byRole?.queue_owner?.timings), true);
    assert.equal(typeof payload.byRole?.queue_owner?.gauges?.["queue.owner.depth"], "object");
  } finally {
    await fs.rm(metricsPath, { force: true });
  }
});

test("integration: perf metrics capture preserves SIGTERM termination semantics", async () => {
  const metricsPath = path.join(os.tmpdir(), `acpx-perf-signal-${Date.now()}.ndjson`);

  try {
    const result = await new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "import { installPerfMetricsCapture } from './dist-test/src/perf-metrics-capture.js';",
            "import { recordPerfDuration } from './dist-test/src/perf-metrics.js';",
            `installPerfMetricsCapture({ filePath: ${JSON.stringify(metricsPath)} });`,
            "recordPerfDuration('signal.test', 1);",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", reject);
      setTimeout(() => {
        child.kill("SIGTERM");
      }, 500);
      child.once("close", (code, signal) => {
        resolve({
          code,
          signal,
          stdout,
          stderr,
        });
      });
    });

    assert.equal(result.code === 143 || result.signal === "SIGTERM", true);
    const records = await readPerfRecords(metricsPath);
    assert.equal(records.length >= 1, true);
  } finally {
    await fs.rm(metricsPath, { force: true });
  }
});

test("integration: configured mcpServers are sent to session/new and session/load", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const loadCapableAgentCommand = `${MOCK_AGENT_COMMAND} --supports-load-session`;
    const loadCapableAgentArgs = [
      "--agent",
      loadCapableAgentCommand,
      "--approve-all",
      "--cwd",
      cwd,
    ];
    let sessionId: string | undefined;

    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          mcpServers: [
            {
              name: "linear-http",
              type: "http",
              url: "https://example.com/mcp",
            },
            {
              name: "local-stdio",
              type: "stdio",
              command: "./bin/local-mcp",
              args: ["--serve"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const expectedMcpServers = [
      {
        name: "linear-http",
        type: "http",
        url: "https://example.com/mcp",
        headers: [],
      },
      {
        name: "local-stdio",
        command: "./bin/local-mcp",
        args: ["--serve"],
        env: [],
      },
    ];

    try {
      const execResult = await runCli(
        [...loadCapableAgentArgs, "--format", "json", "exec", "echo mcp-new"],
        homeDir,
      );
      assert.equal(execResult.code, 0, execResult.stderr);
      const execMessages = parseJsonRpcOutputLines(execResult.stdout);
      const newSessionRequest = execMessages.find(
        (message) => message.method === "session/new" && extractJsonRpcId(message) !== undefined,
      );
      assert(newSessionRequest, `expected session/new request in output:\n${execResult.stdout}`);
      assert.deepEqual(
        (newSessionRequest.params as { mcpServers?: unknown } | undefined)?.mcpServers,
        expectedMcpServers,
      );

      const created = await runCli(
        [...loadCapableAgentArgs, "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const promptResult = await runCli(
        [...loadCapableAgentArgs, "--format", "json", "prompt", "echo mcp-load"],
        homeDir,
      );
      assert.equal(promptResult.code, 0, promptResult.stderr);

      const promptMessages = parseJsonRpcOutputLines(promptResult.stdout);
      const loadSessionRequest = promptMessages.find(
        (message) => message.method === "session/load" && extractJsonRpcId(message) !== undefined,
      );
      assert(
        loadSessionRequest,
        `expected session/load request in output:\n${promptResult.stdout}`,
      );
      assert.deepEqual(
        (loadSessionRequest.params as { mcpServers?: unknown } | undefined)?.mcpServers,
        expectedMcpServers,
      );
    } finally {
      if (sessionId) {
        await runCli([...loadCapableAgentArgs, "--format", "json", "sessions", "close"], homeDir);
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: timeout emits structured TIMEOUT json error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--timeout", "0.05", "exec", "sleep 500"],
        homeDir,
      );
      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              jsonrpc?: string;
              error?: { code?: number; data?: { acpxCode?: string } };
            },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const timeoutError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && payload.error?.data?.acpxCode === "TIMEOUT",
      );
      assert(timeoutError, `expected timeout error payload in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: gemini ACP startup timeout is surfaced as actionable error for gemini.cmd too", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini.cmd");
    const previousTimeout = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;

    try {
      await fs.writeFile(
        fakeGeminiPath,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "0.33.0"\n  exit 0\nfi\nsleep 60\n',
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );
      process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS = "100";

      const result = await runCli(
        [
          "--agent",
          `${JSON.stringify(fakeGeminiPath)} --acp`,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "say exactly: hi",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const timeoutError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "GEMINI_ACP_STARTUP_TIMEOUT",
      );
      assert(timeoutError, result.stdout);
      assert.equal(timeoutError.error?.data?.acpxCode, "TIMEOUT");
      assert.equal(timeoutError.error?.data?.detailCode, "GEMINI_ACP_STARTUP_TIMEOUT");
      assert.match(timeoutError.error?.message ?? "", /Gemini CLI ACP startup timed out/i);
      assert.match(timeoutError.error?.message ?? "", /API-key-based auth/i);
    } finally {
      if (previousTimeout == null) {
        delete process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
      } else {
        process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in gemini falls back to --experimental-acp for Gemini CLI before 0.33.0", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini");

    try {
      await fs.writeFile(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          '  echo "0.32.9"',
          "  exit 0",
          "fi",
          'if [ "$1" = "--experimental-acp" ]; then',
          "  shift",
          `  exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
          "fi",
          'echo "unexpected gemini flag: $1" 1>&2',
          "exit 2",
          "",
        ].join("\n"),
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "gemini", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in gemini keeps --acp for Gemini CLI 0.33.0 and newer", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini");

    try {
      await fs.writeFile(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          '  echo "0.33.0-preview.11"',
          "  exit 0",
          "fi",
          'if [ "$1" = "--acp" ]; then',
          "  shift",
          `  exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
          "fi",
          'echo "unexpected gemini flag: $1" 1>&2',
          "exit 2",
          "",
        ].join("\n"),
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "gemini", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: copilot ACP unsupported binary is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-copilot-"));
    const fakeCopilotPath = path.join(fakeBinDir, "copilot");

    try {
      await fs.writeFile(
        fakeCopilotPath,
        '#!/bin/sh\nif [ "$1" = "--help" ]; then\n  echo \'Usage: copilot [options]\'\n  exit 0\nfi\necho "error: unknown option \'$1\'" 1>&2\nexit 0\n',
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        [
          "--agent",
          `${JSON.stringify(fakeCopilotPath)} --acp --stdio`,
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
          "--name",
          "copilot-timeout",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 1, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const unsupportedError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "COPILOT_ACP_UNSUPPORTED",
      );
      assert(unsupportedError, result.stdout);
      assert.equal(unsupportedError.error?.data?.acpxCode, "RUNTIME");
      assert.equal(unsupportedError.error?.data?.detailCode, "COPILOT_ACP_UNSUPPORTED");
      assert.match(
        unsupportedError.error?.message ?? "",
        /Copilot CLI release that supports --acp --stdio/i,
      );
      assert.match(unsupportedError.error?.message ?? "", /Upgrade GitHub Copilot CLI/i);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: claude ACP session creation timeout is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-claude-acp-"));
    const fakeClaudeAcpPath = path.join(fakeBinDir, "claude-agent-acp");
    const previousTimeout = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;

    try {
      await fs.writeFile(
        fakeClaudeAcpPath,
        `#!/bin/sh\nexec node ${JSON.stringify(MOCK_AGENT_PATH)} --hang-on-new-session "$@"\n`,
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );
      process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = "100";

      const result = await runCli(
        [
          "--agent",
          JSON.stringify(fakeClaudeAcpPath),
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
          "--name",
          "claude-timeout",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const timeoutError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
      );
      assert(timeoutError, result.stdout);
      assert.equal(timeoutError.error?.data?.acpxCode, "TIMEOUT");
      assert.equal(timeoutError.error?.data?.detailCode, "CLAUDE_ACP_SESSION_CREATE_TIMEOUT");
      assert.match(timeoutError.error?.message ?? "", /Claude ACP session creation timed out/i);
      assert.match(timeoutError.error?.message ?? "", /nonInteractivePermissions=deny/i);
      assert.match(timeoutError.error?.message ?? "", /acpx claude exec/i);
    } finally {
      if (previousTimeout == null) {
        delete process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
      } else {
        process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: non-interactive fail emits structured permission error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } });
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(permissionError, `expected ACP error response in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict suppresses runtime stderr diagnostics", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--json-strict",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5);
      assert.equal(result.stderr.trim(), "");

      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } });
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(permissionError, `expected ACP error response in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict exec success emits JSON-RPC lines only", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--json-strict", "exec", "echo strict-success"],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr.trim(), "");
      const payloads = parseJsonRpcOutputLines(result.stdout);
      assert(
        payloads.some((payload) => Object.hasOwn(payload, "result")),
        "expected at least one JSON-RPC result payload",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict exec retries without emitting stderr notices", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--json-strict",
          "--prompt-retries",
          "1",
          "exec",
          "retryable-error-once",
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr.trim(), "");

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const promptRequests = payloads.filter((payload) => payload.method === "session/prompt");
      assert.equal(promptRequests.length, 2, result.stdout);
      assert.equal(
        payloads.some(
          (payload) => extractAgentMessageChunkText(payload) === "recovered after retry",
        ),
        true,
        result.stdout,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli([...baseExecArgs(cwd), `read ${readPath}`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /mock read content/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --suppress-reads hides read file body in text format", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read-tools.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--suppress-reads", "exec", `read-tool ${readPath}`],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /\[tool\] Read/);
      assert.match(result.stdout, /\[read output suppressed\]/);
      assert.doesNotMatch(result.stdout, /mock read content/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --suppress-reads hides read file body in json format", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read-json.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--suppress-reads", "exec", `read ${readPath}`],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      const payloads = parseJsonRpcOutputLines(result.stdout);
      const readResponse = payloads.find((payload) => {
        if (!("result" in payload)) {
          return false;
        }
        return typeof (payload.result as { content?: unknown } | undefined)?.content === "string";
      });
      assert.equal(
        (readResponse?.result as { content?: string } | undefined)?.content,
        "[read output suppressed]",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: late post-success tool updates are rendered before prompt exits", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "text", "prompt", "late-tool 40 follow-up"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /writing now/);
      assert.match(result.stdout, /\[tool\] LateTool/);
      assert.match(result.stdout, /follow-up/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/write_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "acpx-test-write.txt");

    try {
      const result = await runCli([...baseExecArgs(cwd), `write ${writePath} hello`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      const content = await fs.readFile(writePath, "utf8");
      assert.equal(content, "hello");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file outside cwd is denied", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli([...baseExecArgs("/tmp"), "read /etc/hostname"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.toLowerCase(), /error:/);
  });
});

test("integration: terminal lifecycle create/output/wait/release", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "terminal echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
      assert.match(result.stdout, /exit: 0/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: terminal kill leaves no orphan sleep process", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const before = await listSleep60Pids();

    try {
      const result = await runCli([...baseExecArgs(cwd), "kill-terminal sleep 60"], homeDir, {
        timeoutMs: 25_000,
      });
      assert.equal(result.code, 0, result.stderr);
      await assertNoNewSleep60Processes(before);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt reuses warm queue owner and agent pid across turns", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdEvent.acpxRecordId;
      assert.equal(typeof sessionId, "string");
      const sessionRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );

      const first = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo first"],
        homeDir,
      );
      assert.equal(first.code, 0, first.stderr);
      assert.ok(first.stdout.trim().length > 0, "first quiet prompt output should not be empty");
      const firstRecord = JSON.parse(await fs.readFile(sessionRecordPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(Number.isInteger(firstRecord.pid) && (firstRecord.pid ?? 0) > 0, true);

      const { lockPath } = queuePaths(homeDir, sessionId as string);
      const lockOne = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(typeof lockOne.pid, "number");

      const second = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo second"],
        homeDir,
      );
      assert.equal(second.code, 0, second.stderr);
      assert.ok(second.stdout.trim().length > 0, "second quiet prompt output should not be empty");
      const secondRecord = JSON.parse(await fs.readFile(sessionRecordPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(secondRecord.pid, firstRecord.pid);

      const lockTwo = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(lockTwo.pid, lockOne.pid);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
      if (typeof lockTwo.pid !== "number") {
        throw new Error("queue owner lock missing pid");
      }
      assert.equal(await waitForPidExit(lockTwo.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: config agent command with flags is split correctly and stores protocol version", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
      await fs.writeFile(
        path.join(homeDir, ".acpx", "config.json"),
        `${JSON.stringify(
          {
            agents: {
              codex: {
                command: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const created = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        protocol_version?: unknown;
      };
      assert.equal(storedRecord.protocol_version, 1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt recovers when loadSession fails on empty session without emitting load error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flakyLoadAgentCommand = `${MOCK_AGENT_COMMAND} --load-session-fails-on-empty`;

    try {
      const created = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const originalSessionId = createdEvent.acpxRecordId;
      assert.equal(typeof originalSessionId, "string");

      const prompt = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo recovered",
        ],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const payloads = prompt.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; result?: { stopReason?: string } });
      assert.equal(
        payloads.some((payload) => Object.hasOwn(payload, "error")),
        false,
        prompt.stdout,
      );
      assert.equal(
        payloads.some((payload) => payload.result?.stopReason === "end_turn"),
        true,
        prompt.stdout,
      );

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(originalSessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        acp_session_id?: string;
        messages?: unknown[];
      };

      assert.notEqual(storedRecord.acp_session_id, originalSessionId);
      const messages = Array.isArray(storedRecord.messages) ? storedRecord.messages : [];
      assert.equal(
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "Agent" in (message as Record<string, unknown>),
        ),
        true,
      );

      const closed = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "close",
        ],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt retries stop after partial prompt output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli([...baseAgentArgs(cwd), "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--prompt-retries",
          "1",
          "prompt",
          "partial-retryable-error",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, result.stderr);
      assert.equal(/retrying in/.test(result.stderr), false, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const partialUpdates = payloads.filter(
        (payload) => extractAgentMessageChunkText(payload) === "partial update",
      );
      assert.equal(partialUpdates.length, 1, result.stdout);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec retries stop after partial prompt output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--prompt-retries",
          "1",
          "exec",
          "partial-retryable-error",
        ],
        homeDir,
      );
      assert.equal(result.code, 1, result.stderr);
      assert.equal(/retrying in/.test(result.stderr), false, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const partialUpdates = payloads.filter(
        (payload) => extractAgentMessageChunkText(payload) === "partial update",
      );
      assert.equal(partialUpdates.length, 1, result.stdout);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt recovers when loadSession returns not found without emitting load error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const notFoundLoadAgentCommand = `${MOCK_AGENT_COMMAND} --supports-load-session --load-session-not-found`;

    try {
      const created = await runCli(
        [
          "--agent",
          notFoundLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const originalSessionId = createdEvent.acpxRecordId;
      assert.equal(typeof originalSessionId, "string");

      const prompt = await runCli(
        [
          "--agent",
          notFoundLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo recovered",
        ],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const payloads = prompt.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; result?: { stopReason?: string } });

      assert.equal(
        payloads.some((payload) => Object.hasOwn(payload, "error")),
        false,
        prompt.stdout,
      );
      assert.equal(
        payloads.some((payload) => payload.result?.stopReason === "end_turn"),
        true,
        prompt.stdout,
      );

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(originalSessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        acp_session_id?: string;
      };
      assert.notEqual(storedRecord.acp_session_id, originalSessionId);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: load replay session/update notifications are suppressed from output and event log", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const replayText = "replay-load-chunk";
    const freshText = "fresh-after-load";
    const replayLoadAgentCommand =
      `${MOCK_AGENT_COMMAND} --supports-load-session ` +
      `--replay-load-session-updates --load-replay-text ${replayText}`;
    const replayAgentArgs = ["--agent", replayLoadAgentCommand, "--approve-all", "--cwd", cwd];
    let sessionId: string | undefined;

    try {
      const created = await runCli(
        [...replayAgentArgs, "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const prompt = await runCli(
        [...replayAgentArgs, "--format", "json", "prompt", `echo ${freshText}`],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const outputMessages = parseJsonRpcOutputLines(prompt.stdout);
      const outputChunkTexts = new Set(
        outputMessages
          .map((message) => extractAgentMessageChunkText(message))
          .filter((text): text is string => typeof text === "string"),
      );

      assert.equal(outputChunkTexts.has(replayText), false, prompt.stdout);
      assert.equal(outputChunkTexts.has(freshText), true, prompt.stdout);

      const loadRequest = outputMessages.find((message) => {
        return message.method === "session/load" && extractJsonRpcId(message) !== undefined;
      });
      assert(loadRequest, `expected session/load request in output:\n${prompt.stdout}`);

      const loadRequestId = extractJsonRpcId(loadRequest);
      assert.notEqual(loadRequestId, undefined);
      assert.equal(
        outputMessages.some(
          (message) =>
            extractJsonRpcId(message) === loadRequestId && Object.hasOwn(message, "result"),
        ),
        true,
        prompt.stdout,
      );

      const recordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        event_log?: {
          active_path?: string;
        };
      };
      const activeEventPath = storedRecord.event_log?.active_path;
      assert.equal(typeof activeEventPath, "string");

      const eventLog = await fs.readFile(activeEventPath as string, "utf8");
      const eventMessages = eventLog
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const eventChunkTexts = new Set(
        eventMessages
          .map((message) => extractAgentMessageChunkText(message))
          .filter((text): text is string => typeof text === "string"),
      );

      assert.equal(eventChunkTexts.has(replayText), false, eventLog);
      assert.equal(eventChunkTexts.has(freshText), true, eventLog);
    } finally {
      if (sessionId) {
        const lock = await readQueueOwnerLock(homeDir, sessionId).catch(() => undefined);
        await runCli([...replayAgentArgs, "--format", "json", "sessions", "close"], homeDir);
        if (lock) {
          await waitForPidExit(lock.pid, 5_000);
        }
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: cancel yields cancelled stopReason without queue error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    let sessionId: string | undefined;

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const promptChild = spawn(
        process.execPath,
        [CLI_PATH, ...baseAgentArgs(cwd), "--format", "json", "prompt", "sleep 5000"],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        const doneEventPromise = waitForPromptDoneEvent(promptChild, 20_000, "prompt");

        let cancelled = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const cancelResult = await runCli(
            [...baseAgentArgs(cwd), "--format", "json", "cancel"],
            homeDir,
          );
          assert.equal(cancelResult.code, 0, cancelResult.stderr);

          const payload = JSON.parse(cancelResult.stdout.trim()) as {
            action?: string;
            cancelled?: boolean;
          };
          assert.equal(payload.action, "cancel_result");
          cancelled = payload.cancelled === true;
          if (cancelled) {
            break;
          }

          await sleep(100);
        }

        assert.equal(cancelled, true, "cancel command never reached active queue owner");

        const promptResult = await doneEventPromise;
        assert.equal(
          promptResult.events.some((event) => event.result?.stopReason === "cancelled"),
          true,
          promptResult.stdout,
        );
        assert.equal(
          promptResult.events.some((event) => Object.hasOwn(event, "error")),
          false,
          promptResult.stdout,
        );
      } finally {
        await stopChildProcess(promptChild, 5_000, "prompt");
        if (sessionId) {
          const lock = await readQueueOwnerLock(homeDir, sessionId).catch(() => undefined);
          await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
          if (lock) {
            await waitForPidExit(lock.pid, 5_000);
          }
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt exits after done while detached owner stays warm", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
        acpx_record_id?: string;
        acpSessionId?: string;
        acp_session_id?: string;
        sessionId?: string;
        session_id?: string;
      };
      const sessionId =
        createdPayload.acpxRecordId ??
        createdPayload.acpx_record_id ??
        createdPayload.acpSessionId ??
        createdPayload.acp_session_id ??
        createdPayload.sessionId ??
        createdPayload.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`missing session id in sessions new output: `);
      }

      const firstPromptStartedAt = Date.now();
      const firstPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "3600",
          "prompt",
          "say exactly: warm-owner-ready",
        ],
        homeDir,
      );
      const firstPromptDurationMs = Date.now() - firstPromptStartedAt;
      assert.equal(firstPrompt.code, 0, firstPrompt.stderr);
      assert.match(firstPrompt.stdout, /warm-owner-ready/);
      assert.equal(
        firstPromptDurationMs < 8_000,
        true,
        `expected prompt to return quickly, got ${firstPromptDurationMs}ms`,
      );

      const lock = await readQueueOwnerLock(homeDir, sessionId);
      assert.equal(Number.isInteger(lock.pid) && lock.pid > 0, true);
      assert.equal(isPidAlive(lock.pid), true);

      const secondPrompt = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "say exactly: second-turn"],
        homeDir,
      );
      assert.equal(secondPrompt.code, 0, secondPrompt.stderr);
      assert.match(secondPrompt.stdout, /second-turn/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);

      assert.equal(await waitForPidExit(lock.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt --no-wait is processed by the detached queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const queued = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "5",
          "prompt",
          "--no-wait",
          "say exactly: no-wait-done",
        ],
        homeDir,
      );
      assert.equal(queued.code, 0, queued.stderr);
      const queuedPayload = JSON.parse(queued.stdout.trim()) as {
        action?: string;
        acpxRecordId?: string;
      };
      assert.equal(queuedPayload.action, "prompt_queued");

      await waitFor(async () => {
        const history = await runCli(
          [...baseAgentArgs(cwd), "--format", "quiet", "sessions", "read"],
          homeDir,
        );
        assert.equal(history.code, 0, history.stderr);
        return history.stdout.includes("no-wait-done") ? history.stdout : null;
      }, 5_000);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: session remains resumable after queue owner exits and agent has exited", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      // 1. Create a persistent session
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      // 2. Send a prompt with a very short TTL so the queue owner exits quickly
      const prompt = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "--ttl", "1", "prompt", "echo oneshot-done"],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);
      assert.match(prompt.stdout, /oneshot-done/);

      // 3. Wait for the queue owner to exit (it should exit after 1s TTL)
      const { lockPath } = queuePaths(homeDir, sessionId as string);
      let ownerPid: number | undefined;
      try {
        const lockPayload = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          pid?: number;
        };
        ownerPid = lockPayload.pid;
      } catch {
        // lock file may already be gone
      }

      if (typeof ownerPid === "number") {
        assert.equal(await waitForPidExit(ownerPid, 10_000), true, "queue owner did not exit");
      }

      // Give a moment for final writes
      await sleep(500);

      // 4. Read the session record from disk
      const recordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        closed?: boolean;
        closed_at?: string;
        last_agent_exit_at?: string;
        last_agent_exit_code?: number | null;
      };

      // 5. Routine queue-owner shutdown must not permanently close
      //    a resumable persistent session.
      assert.equal(
        storedRecord.last_agent_exit_at != null,
        true,
        "expected last_agent_exit_at to be set (agent has exited)",
      );

      assert.equal(
        storedRecord.closed,
        false,
        "session should remain resumable after queue owner shutdown",
      );

      assert.equal(
        storedRecord.closed_at,
        undefined,
        "closed_at should remain unset for resumable sessions",
      );
    } finally {
      // Clean up: close session if it's still around
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir).catch(
        () => {},
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

function baseAgentArgs(cwd: string): string[] {
  return ["--agent", MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

function baseLoadCapableAgentArgs(cwd: string): string[] {
  return ["--agent", LOAD_CAPABLE_MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

function baseExecArgs(cwd: string): string[] {
  return [...baseAgentArgs(cwd), "--format", "quiet", "exec"];
}

async function writeFakeCursorAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "cursor-agent.cmd"),
      [
        "@echo off",
        "setlocal",
        'if "%~1"=="acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "cursor-agent"),
    [
      "#!/bin/sh",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeDroidAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "droid.cmd"),
      [
        "@echo off",
        "setlocal",
        'if /I "%~1"=="exec" shift',
        'if /I "%~1"=="--output-format" shift',
        'if /I "%~1"=="acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "droid"),
    [
      "#!/bin/sh",
      'if [ "$1" = "exec" ]; then',
      "  shift",
      "fi",
      'if [ "$1" = "--output-format" ]; then',
      "  shift",
      "fi",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeIflowAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "iflow.cmd"),
      [
        "@echo off",
        "setlocal",
        'if "%~1"=="--experimental-acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "iflow"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--experimental-acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeQoderAgent(binDir: string, argLogPath?: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "qodercli.cmd"),
      [
        "@echo off",
        "setlocal",
        ...(argLogPath ? [`echo %*>> "${argLogPath}"`] : []),
        ":shift_known",
        'if "%~1"=="--acp" shift & goto shift_known',
        'if /I "%~1"=="--max-turns" shift & shift & goto shift_known',
        'if /I "%~1"=="--allowed-tools" shift & shift & goto shift_known',
        'if /I "%~1"=="--disallowed-tools" shift & shift & goto shift_known',
        'echo %~1 | findstr /B /C:"--max-turns=" >nul && shift & goto shift_known',
        'echo %~1 | findstr /B /C:"--allowed-tools=" >nul && shift & goto shift_known',
        'echo %~1 | findstr /B /C:"--disallowed-tools=" >nul && shift & goto shift_known',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "qodercli"),
    [
      "#!/bin/sh",
      ...(argLogPath ? [`printf '%s\\n' "$*" >> ${JSON.stringify(argLogPath)}`] : []),
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    --acp|--max-turns=*|--allowed-tools=*|--disallowed-tools=*)",
      "      shift",
      "      ;;",
      "    --max-turns|--allowed-tools|--disallowed-tools)",
      "      shift",
      '      [ "$#" -gt 0 ] && shift',
      "      ;;",
      "    *)",
      "      break",
      "      ;;",
      "  esac",
      "done",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function waitForFlowRunDir(outputRoot: string, flowName: string): Promise<string> {
  return await waitFor(async () => {
    const entries = await fs.readdir(outputRoot).catch(() => []);
    const match = entries.find((entry) => entry.includes(flowName));
    return match ? path.join(outputRoot, match) : null;
  }, 5_000);
}

async function readFlowRunJson(runDir: string): Promise<Record<string, unknown>> {
  const payload = await fs.readFile(path.join(runDir, "projections", "run.json"), "utf8");
  return JSON.parse(payload) as Record<string, unknown>;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value != null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for condition");
}

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await runCliWithEntry(CLI_PATH, args, homeDir, options);
}

async function runCliWithEntry(
  entryPath: string,
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
        ...options.env,
      },
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function awaitChildClose(child: ReturnType<typeof spawn>): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runPerfReport(filePath: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/perf-report.ts", filePath], {
      env: {
        ...process.env,
        NODE_V8_COVERAGE: "",
      },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function readPerfRecords(metricsPath: string): Promise<
  Array<{
    role?: string;
    reason?: string;
    metrics?: {
      timings?: Record<string, unknown>;
    };
  }>
> {
  try {
    const payload = await fs.readFile(metricsPath, "utf8");
    return payload
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            role?: string;
            reason?: string;
            metrics?: { timings?: Record<string, unknown> };
          },
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readPerfTimingCount(
  record: {
    metrics?: {
      timings?: Record<string, unknown>;
    };
  },
  name: string,
): number | undefined {
  const value = record.metrics?.timings?.[name];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const count = (value as { count?: unknown }).count;
  return typeof count === "number" ? count : undefined;
}

async function waitForValue<T>(
  load: () => Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await load();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

type PromptEvent = {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: {
    stopReason?: string;
  };
  error?: {
    code?: unknown;
    message?: string;
  };
};

type PromptDoneResult = {
  events: PromptEvent[];
  stdout: string;
  stderr: string;
};

async function waitForPromptDoneEvent(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<PromptDoneResult> {
  return await new Promise<PromptDoneResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const events: PromptEvent[] = [];
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      child.off("close", onClose);
      child.off("error", onError);
      run();
    };

    const parseLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }

      let event: PromptEvent;
      try {
        event = JSON.parse(trimmed) as PromptEvent;
      } catch {
        finish(() => {
          reject(
            new Error(
              `${label} emitted invalid JSON line: ${trimmed}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        });
        return;
      }

      events.push(event);
      if (event.result?.stopReason) {
        finish(() => {
          resolve({
            events,
            stdout,
            stderr,
          });
        });
      }
    };

    const flushLineBuffer = (): void => {
      const remainder = lineBuffer.trim();
      if (remainder.length > 0) {
        parseLine(remainder);
      }
      lineBuffer = "";
    };

    const onStdoutData = (chunk: string): void => {
      stdout += chunk;
      lineBuffer += chunk;

      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        parseLine(line);
        if (settled) {
          return;
        }
      }
    };

    const onStderrData = (chunk: string): void => {
      stderr += chunk;
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      flushLineBuffer();
      if (settled) {
        return;
      }
      finish(() => {
        reject(
          new Error(
            `${label} exited before done event (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`${label} process timed out waiting for done event`));
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

async function stopChildProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not exit after SIGKILL within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function listSleep60Pids(): Promise<Set<number>> {
  const output = await runCommand("ps", ["-eo", "pid=,args="]);
  const pids = new Set<number>();

  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const commandLine = match[2].trim();
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (/(^|\s)sleep 60(\s|$)/.test(commandLine)) {
      pids.add(pid);
    }
  }

  return pids;
}

async function assertNoNewSleep60Processes(
  baseline: Set<number>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = await listSleep60Pids();
    const leaked = [...current].filter((pid) => !baseline.has(pid));
    if (leaked.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      for (const pid of leaked) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // best-effort cleanup
        }
      }
      assert.fail(`Found orphan sleep process(es): ${leaked.join(", ")}`);
    }

    await sleep(100);
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

function queueOwnerLockPath(homeDir: string, sessionId: string): string {
  const queueKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(homeDir, ".acpx", "queues", `${queueKey}.lock`);
}

async function readQueueOwnerLock(homeDir: string, sessionId: string): Promise<{ pid: number }> {
  const lockPath = queueOwnerLockPath(homeDir, sessionId);
  const payload = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(payload) as { pid?: unknown };
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`queue owner lock missing valid pid: ${payload}`);
  }
  return {
    pid,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isPidAlive(pid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("runPromptTurn: post-success drain runs before closing the turn", async () => {
  const calls: string[] = [];
  const client = {
    prompt: async () => {
      calls.push("prompt");
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number; timeoutMs?: number }) => {
      calls.push(`drain(${options?.idleMs ?? 0}/${options?.timeoutMs ?? 0})`);
    },
  };

  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  const result = await runPromptTurn({
    client,
    sessionId: "session-under-test",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(
    calls,
    ["prompt", "drain(1000/5000)"],
    "post-success drain must run before runPromptTurn returns",
  );
});

test("runPromptTurn: late session updates after successful prompt reach the drain", async () => {
  const observed: string[] = [];
  let lateUpdateEmitted = false;
  const client = {
    prompt: async () => {
      observed.push("prompt-resolved");
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number; timeoutMs?: number }) => {
      // Simulate a late assistant_delta / tool_call arriving shortly after prompt resolves.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      lateUpdateEmitted = true;
      observed.push(`drain-completed(idle=${options?.idleMs ?? 0})`);
    },
  };

  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  const result = await runPromptTurn({
    client,
    sessionId: "session-late-updates",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(lateUpdateEmitted, true, "late session update must be consumed before turn closes");
  assert.deepEqual(observed, ["prompt-resolved", "drain-completed(idle=1000)"]);
});

test("runPromptTurn: missing waitForSessionUpdatesIdle still returns cleanly on success", async () => {
  const client = {
    prompt: async () => ({ stopReason: "end_turn" as const }),
  };

  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  const result = await runPromptTurn({
    client,
    sessionId: "session-no-drain",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(result.stopReason, "end_turn");
});

test("runPromptTurn: existing agent reply still allows post-success drain", async () => {
  const calls: string[] = [];
  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  assert.ok(promptMessageId);
  recordSessionUpdate(conversation, undefined, {
    sessionId: "session-existing-reply",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "already visible" },
    },
  });
  const client = {
    prompt: async () => {
      calls.push("prompt");
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async () => {
      calls.push("drain");
    },
  };

  const result = await runPromptTurn({
    client,
    sessionId: "session-existing-reply",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(calls, ["prompt", "drain"]);
});
