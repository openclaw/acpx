import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { promptForPermission } from "../src/permission-prompt.js";
import { withCapturedStderrWrites, withMockedReadline, withTtyState } from "./tty-test-helpers.js";

test("promptForPermission returns false when stdin or stderr is not a TTY", async () => {
  await withTtyState({ stdin: false, stderr: true }, async () => {
    const allowed = await promptForPermission({ prompt: "Allow? " });
    assert.equal(allowed, false);
  });
});

test("promptForPermission writes header/details and accepts yes answers", async () => {
  let closeCalls = 0;
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withCapturedStderrWrites(async (writes) => {
      await withMockedReadline(
        () => ({
          question: async (prompt: string) => {
            writes.push(prompt);
            return "  YES ";
          },
          close: () => {
            closeCalls += 1;
          },
        }),
        async () => {
          const allowed = await promptForPermission({
            prompt: "Allow? ",
            header: "Permission Request",
            details: "Tool wants to edit a file.",
          });

          assert.equal(allowed, true);
          assert.equal(closeCalls, 1);
          assert.deepEqual(writes, [
            "\nPermission Request\n",
            "Tool wants to edit a file.\n",
            "Allow? ",
          ]);
        },
      );
    });
  });
});

test("promptForPermission rejects non-yes answers and skips blank details", async () => {
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withCapturedStderrWrites(async (writes) => {
      await withMockedReadline(
        () => ({
          question: async () => "no",
          close: () => {},
        }),
        async () => {
          const allowed = await promptForPermission({
            prompt: "Allow? ",
            header: "Header",
            details: "   ",
          });

          assert.equal(allowed, false);
          assert.deepEqual(writes, ["\nHeader\n"]);
        },
      );
    });
  });
});

for (const firstAnswer of ["y\n", "y\ny\n"]) {
  test(
    `concurrent permission prompts require separate answers (${JSON.stringify(firstAnswer)})`,
    { timeout: 15_000 },
    async (t) => {
      let firstAnswered = false;
      let secondAnswered = false;
      const result = await runPromptProcess(
        t,
        `
    const results = await Promise.all([
      promptForPermission({ prompt: 'Allow first? ' }),
      promptForPermission({ prompt: 'Allow second? ' }),
    ]);
    console.log(JSON.stringify(results));
    `,
        (stderr, child) => {
          if (!firstAnswered && stderr.includes("Allow first?")) {
            firstAnswered = true;
            child.stdin.write(firstAnswer);
          }
          if (!secondAnswered && stderr.includes("Allow second?")) {
            secondAnswered = true;
            child.stdin.write("n\n");
          }
        },
      );
      assert.equal(firstAnswered, true);
      assert.equal(secondAnswered, true);
      assert.deepEqual(JSON.parse(result.stdout), [true, false]);
    },
  );
}

test(
  "EOF denies active and queued questions and releases signal listeners",
  { timeout: 15_000 },
  async (t) => {
    const result = await runPromptProcess(
      t,
      `
    const controller = new AbortController();
    const results = await Promise.all([
      promptForPermission({ prompt: 'Allow first? ', signal: controller.signal }),
      promptForPermission({ prompt: 'Allow second? ', signal: controller.signal }),
    ]);
    console.log(JSON.stringify({ results, listeners: getEventListeners(controller.signal, 'abort').length }));
  `,
      (stderr, child) => {
        if (stderr.includes("Allow first?")) {
          child.stdin.end();
        }
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), { results: [false, false], listeners: 0 });
    assert.doesNotMatch(result.stderr, /Allow second/u);
  },
);

test(
  "a cancelled queued question cannot release the active input owner",
  { timeout: 15_000 },
  async (t) => {
    let firstAnswered = false;
    let thirdAnswered = false;
    const result = await runPromptProcess(
      t,
      `
    const controller = new AbortController();
    const first = promptForPermission({ prompt: 'Allow first? ' });
    const second = promptForPermission({ prompt: 'Allow second? ', header: 'Second header', signal: controller.signal });
    const third = promptForPermission({ prompt: 'Allow third? ' });
    controller.abort(new Error('queued cancellation'));
    const cancelled = await second.then(() => 'unexpected', () => 'cancelled');
    process.stderr.write('cancelled-second');
    console.log(JSON.stringify([await first, cancelled, await third]));
  `,
      (stderr, child) => {
        if (
          !firstAnswered &&
          stderr.includes("cancelled-second") &&
          stderr.includes("Allow first?")
        ) {
          firstAnswered = true;
          child.stdin.write("y\n");
        }
        if (!thirdAnswered && stderr.includes("Allow third?")) {
          thirdAnswered = true;
          child.stdin.write("n\n");
        }
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), [true, "cancelled", false]);
    assert.doesNotMatch(result.stderr, /Allow second|Second header/u);
  },
);

test(
  "active cancellation closes readline and advances to the next question",
  { timeout: 15_000 },
  async (t) => {
    let answered = false;
    const result = await runPromptProcess(
      t,
      `
    const controller = new AbortController();
    const first = promptForPermission({ prompt: 'Allow first? ', signal: controller.signal }).catch(() => 'cancelled');
    const second = promptForPermission({ prompt: 'Allow second? ' });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('active cancellation'));
    console.log(JSON.stringify({ results: [await first, await second], listeners: getEventListeners(controller.signal, 'abort').length }));
  `,
      (stderr, child) => {
        if (!answered && stderr.includes("Allow second?")) {
          answered = true;
          child.stdin.write("n\n");
        }
      },
    );
    assert.match(result.stderr, /Allow first/u);
    assert.deepEqual(JSON.parse(result.stdout), { results: ["cancelled", false], listeners: 0 });
  },
);

test("a failed question releases its queue slot", async () => {
  let interfaces = 0;
  let closed = 0;
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withMockedReadline(
      () => {
        const index = interfaces++;
        return {
          question: async () => {
            if (index === 0) {
              throw new Error("question failed");
            }
            return "yes";
          },
          close: () => {
            closed += 1;
          },
        };
      },
      async () => {
        const first = promptForPermission({ prompt: "First?" });
        const second = promptForPermission({ prompt: "Second?" });
        await assert.rejects(first, /question failed/u);
        assert.equal(await second, true);
        assert.equal(closed, 2);
      },
    );
  });
});

async function runPromptProcess(
  t: TestContext,
  body: string,
  onStderr: (output: string, child: ChildProcessWithoutNullStreams) => void,
): Promise<{ stdout: string; stderr: string }> {
  const target = new URL("../src/permission-prompt.js", import.meta.url).href;
  const script = `
    import { promptForPermission } from ${JSON.stringify(target)};
    import { getEventListeners } from 'node:events';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true });
    ${body}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    onStderr(stderr, child);
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  return { stdout, stderr };
}
