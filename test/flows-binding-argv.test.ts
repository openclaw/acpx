import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderArgvIdentity } from "../src/acp/client-process.js";
import { FlowRunner, acp, defineFlow } from "../src/flows/runtime.js";
import type { FlowRunManifest, FlowSessionBinding } from "../src/flows/types.js";
import type { SessionRecord } from "../src/types.js";
import { withTempHome } from "./runtime-test-helpers.js";

const PEER = fileURLToPath(new URL("./fixtures/flow-binding-argv-peer.js", import.meta.url));
const DISPLAY_COMMAND = "shared-synthetic-display-command";

type Step = { id: string; profile: string };
type PeerReply = { invocation: string[]; sessionId: string; prompt: string };
type Receipt = {
  kind: "started" | "request" | "created";
  pid: number;
  invocation: string[];
  method?: string;
  sessionId?: string;
  prompt?: string;
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

function bundleFile(runDir: string, relativePath: string): string {
  assert.equal(path.isAbsolute(relativePath), false);
  const file = path.resolve(runDir, ...relativePath.split("/"));
  const relative = path.relative(runDir, file);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes(".."));
  return file;
}

async function assertRouting(
  profiles: Record<string, string[]>,
  steps: Step[],
  rawCommand = false,
): Promise<void> {
  await withTempHome("acpx-flow-binding-argv-", async (home) => {
    const cwd = path.join(home, "workspace");
    const stateDirectory = path.join(home, "peer-state");
    const receiptPath = path.join(home, "peer.jsonl");
    await fs.mkdir(cwd);
    await fs.mkdir(stateDirectory);
    await fs.writeFile(receiptPath, "");
    const vectors: Record<string, string[]> = Object.fromEntries(
      Object.entries(profiles).map(([profile, invocation]) => [
        profile,
        [process.execPath, PEER, receiptPath, stateDirectory, ...invocation],
      ]),
    );
    const runner = new FlowRunner({
      resolveAgent: (profile = steps[0].profile) => {
        const argv = vectors[profile];
        assert.ok(argv, `unknown fixture profile ${profile}`);
        return {
          agentName: "synthetic",
          // Profile labels deliberately do not distinguish the actual vectors.
          agentCommand: rawCommand ? renderArgvIdentity(argv) : DISPLAY_COMMAND,
          ...(rawCommand ? {} : { agentArgv: [...argv] }),
          cwd,
        };
      },
      permissionMode: "deny-all",
      defaultNodeTimeoutMs: 10_000,
      outputRoot: path.join(home, "runs"),
    });
    const flow = defineFlow({
      name: "binding-argv-routing",
      startAt: steps[0].id,
      nodes: Object.fromEntries(
        steps.map((step) => [
          step.id,
          acp({
            profile: step.profile,
            session: { handle: "shared" },
            prompt: () => step.id,
            parse: (text) => JSON.parse(text) as PeerReply,
          }),
        ]),
      ),
      edges: steps.slice(1).map((step, index) => ({ from: steps[index].id, to: step.id })),
    });

    const result = await runner.run(flow, {});
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.steps.length, steps.length);
    const bindings = Object.values(result.state.sessionBindings);
    const expectedGroups = new Set(
      Object.values(profiles).map((invocation) => JSON.stringify(invocation)),
    );

    const sessionByInvocation = new Map<string, string>();
    for (const step of steps) {
      const expected = profiles[step.profile];
      const reply = result.state.outputs[step.id] as PeerReply;
      assert.deepEqual(reply.invocation, expected, `${step.id} reached the wrong invocation`);
      assert.equal(reply.prompt, step.id);
      const key = JSON.stringify(expected);
      const prior = sessionByInvocation.get(key);
      if (prior !== undefined) {
        assert.equal(reply.sessionId, prior, "same-vector reuse must load the original session");
      } else {
        assert.ok(![...sessionByInvocation.values()].includes(reply.sessionId));
        sessionByInvocation.set(key, reply.sessionId);
      }
      const binding = bindings.find((item) => item.acpSessionId === reply.sessionId);
      assert.ok(binding);
      assert.equal(binding.handle, "shared");
      assert.equal(binding.cwd, cwd);
      assert.equal(
        binding.agentCommand,
        rawCommand ? renderArgvIdentity(vectors[step.profile]) : DISPLAY_COMMAND,
      );
      assert.deepEqual(binding.agentArgv, rawCommand ? undefined : vectors[step.profile]);
      const recorded = result.state.steps.find((item) => item.nodeId === step.id);
      assert.equal(recorded?.session?.bundleId, binding.bundleId);
      assert.equal(recorded?.session?.acpxRecordId, binding.acpxRecordId);
      assert.equal(recorded?.session?.acpSessionId, reply.sessionId);
    }
    assert.equal(bindings.length, expectedGroups.size);
    assert.equal(new Set(bindings.map((binding) => binding.key)).size, expectedGroups.size);
    assert.equal(new Set(bindings.map((binding) => binding.bundleId)).size, expectedGroups.size);
    assert.equal(
      new Set(bindings.map((binding) => binding.acpxRecordId)).size,
      expectedGroups.size,
    );

    const manifest = await readJson<FlowRunManifest>(path.join(result.runDir, "manifest.json"));
    assert.equal(manifest.sessions.length, expectedGroups.size);
    for (const entry of manifest.sessions) {
      const [binding, record] = await Promise.all([
        readJson<FlowSessionBinding>(bundleFile(result.runDir, entry.bindingPath)),
        readJson<SessionRecord>(bundleFile(result.runDir, entry.recordPath)),
      ]);
      const expected = bindings.find((item) => item.bundleId === entry.id);
      assert.ok(expected);
      assert.deepEqual(binding, JSON.parse(JSON.stringify(expected)) as FlowSessionBinding);
      assert.equal(record.acpxRecordId, expected.acpxRecordId);
      assert.equal(record.acpSessionId, expected.acpSessionId);
      assert.deepEqual(record.agentArgv, expected.agentArgv);
    }

    const receipts = (await fs.readFile(receiptPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Receipt);
    const prompts = receipts.filter(
      (entry) => entry.kind === "request" && entry.method === "session/prompt",
    );
    assert.deepEqual(
      prompts.map(({ invocation, prompt, sessionId }) => ({ invocation, prompt, sessionId })),
      steps.map((step) => ({
        invocation: profiles[step.profile],
        prompt: step.id,
        sessionId: sessionByInvocation.get(JSON.stringify(profiles[step.profile])),
      })),
    );
    const created = receipts.filter((entry) => entry.kind === "created");
    assert.equal(
      created.length,
      expectedGroups.size,
      "returning to a vector must not create a replacement",
    );
    for (const [invocation, sessionId] of sessionByInvocation) {
      const creations = created.filter((entry) => JSON.stringify(entry.invocation) === invocation);
      assert.equal(creations.length, 1);
      assert.equal(creations[0].sessionId, sessionId);
    }
    for (const load of receipts.filter(
      (entry) => entry.kind === "request" && entry.method === "session/load",
    )) {
      assert.equal(load.sessionId, sessionByInvocation.get(JSON.stringify(load.invocation)));
    }
    const starts = receipts.filter((entry) => entry.kind === "started");
    assert.ok(starts.length >= expectedGroups.size);
    for (const { pid } of starts) {
      assert.throws(
        () => process.kill(pid, 0),
        { code: "ESRCH" },
        `fixture peer ${pid} survived the flow`,
      );
    }
  });
}

test(
  "persistent flow profiles route alpha, beta, alpha by their explicit argv",
  { timeout: 60_000 },
  async () => {
    await assertRouting({ alpha: ["alpha"], beta: ["beta"] }, [
      { id: "alpha-first", profile: "alpha" },
      { id: "beta-only", profile: "beta" },
      { id: "alpha-again", profile: "alpha" },
    ]);
  },
);

test(
  "equal argv values reuse a persistent binding across profile aliases",
  { timeout: 60_000 },
  async () => {
    await assertRouting({ first: ["shared", "same value"], alias: ["shared", "same value"] }, [
      { id: "first", profile: "first" },
      { id: "alias", profile: "alias" },
      { id: "first-again", profile: "first" },
    ]);
  },
);

test(
  "flow invocation identity preserves argument boundaries and empty arguments",
  { timeout: 60_000 },
  async () => {
    await assertRouting(
      {
        joined: ["arguments", "two words", ""],
        split: ["arguments", "two", "words", ""],
        absent: ["arguments"],
        empty: ["arguments", ""],
      },
      [
        { id: "joined", profile: "joined" },
        { id: "split", profile: "split" },
        { id: "absent", profile: "absent" },
        { id: "empty", profile: "empty" },
        { id: "joined-again", profile: "joined" },
      ],
    );
  },
);

test(
  "ordinary POSIX raw-command flows retain same-command persistent reuse",
  { skip: process.platform === "win32", timeout: 60_000 },
  async () => {
    await assertRouting(
      { first: ["legacy"], alias: ["legacy"] },
      [
        { id: "first", profile: "first" },
        { id: "again", profile: "alias" },
      ],
      true,
    );
  },
);

for (const isolated of [false, true]) {
  test(
    `flow bindings retain borrowed resolver argv for ${isolated ? "isolated" : "persistent"} sessions`,
    { timeout: 60_000 },
    async () => {
      await withTempHome("acpx-flow-borrowed-argv-", async (home) => {
        const receiptPath = path.join(home, "peer.jsonl");
        const stateDirectory = path.join(home, "peer-state");
        await fs.mkdir(stateDirectory);
        const profiles = ["alpha", "beta"] as const;
        const vectors = Object.fromEntries(
          profiles.map((profile) => [
            profile,
            [process.execPath, PEER, receiptPath, stateDirectory, profile],
          ]),
        );
        const borrowedArgv: string[] = [];
        const runner = new FlowRunner({
          resolveAgent: (profile = "alpha") => {
            borrowedArgv.splice(0, borrowedArgv.length, ...vectors[profile]);
            return {
              agentName: "synthetic",
              agentCommand: DISPLAY_COMMAND,
              agentArgv: borrowedArgv,
              cwd: home,
            };
          },
          permissionMode: "deny-all",
          defaultNodeTimeoutMs: 10_000,
          outputRoot: path.join(home, "runs"),
        });
        const result = await runner.run(
          defineFlow({
            name: "borrowed-argv",
            startAt: "alpha",
            nodes: Object.fromEntries(
              profiles.map((profile) => [
                profile,
                acp({
                  profile,
                  session: { handle: profile, isolated },
                  prompt: () => profile,
                  parse: (text) => JSON.parse(text) as PeerReply,
                }),
              ]),
            ),
            edges: [{ from: "alpha", to: "beta" }],
          }),
          {},
        );
        assert.equal(result.state.status, "completed");
        assert.deepEqual(borrowedArgv, vectors.beta);
        for (const profile of profiles) {
          const reply = result.state.outputs[profile] as PeerReply;
          assert.deepEqual(reply.invocation, [profile]);
          assert.equal(reply.prompt, profile);
        }
        const manifest = await readJson<FlowRunManifest>(path.join(result.runDir, "manifest.json"));
        assert.equal(manifest.sessions.length, 2);
        for (const step of result.state.steps) {
          const binding = step.session;
          assert.ok(binding);
          assert.deepEqual(binding.agentArgv, vectors[step.nodeId]);
          const entry = manifest.sessions.find((session) => session.id === binding.bundleId);
          assert.ok(entry);
          const record = await readJson<SessionRecord>(bundleFile(result.runDir, entry.recordPath));
          const saved = await readJson<FlowSessionBinding>(
            bundleFile(result.runDir, entry.bindingPath),
          );
          assert.deepEqual(record.agentArgv, vectors[step.nodeId]);
          assert.deepEqual(saved.agentArgv, vectors[step.nodeId]);
          if (!isolated) {
            assert.deepEqual(
              result.state.sessionBindings[binding.key].agentArgv,
              vectors[step.nodeId],
            );
          }
        }
      });
    },
  );
}
