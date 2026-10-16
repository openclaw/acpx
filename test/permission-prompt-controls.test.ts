import assert from "node:assert/strict";
import test from "node:test";
import { promptForPermission } from "../src/permission-prompt.js";
import { withCapturedStderrWrites, withMockedReadline, withTtyState } from "./tty-test-helpers.js";

for (const answer of ["n", "yes"]) {
  test(`permission controls remain visible with answer ${answer}`, async () => {
    const options = Object.freeze({
      header: "[permission] Allow write to notes\rHIDDEN.txt?",
      details: "first\r\u001b[1Ahidden\nsecond\tline\u007f\u009f",
      prompt: '\n[permission] Allow command "echo\r\u001b[2Khidden\nnext"? (y/N) ',
    });
    await withTtyState({ stdin: true, stderr: true }, async () => {
      await withCapturedStderrWrites(async (writes) => {
        await withMockedReadline(
          () => ({
            question: async (prompt) => {
              writes.push(prompt);
              return answer;
            },
            close: () => {},
          }),
          async () => {
            assert.equal(await promptForPermission(options), answer === "yes");
          },
        );
        assert.deepEqual(writes, [
          "\n[permission] Allow write to notes\\x0dHIDDEN.txt?\n",
          "first\\x0d\\x1b[1Ahidden\nsecond\\x09line\\x7f\\x9f\n",
          '\n[permission] Allow command "echo\\x0d\\x1b[2Khidden\\x0anext"? (y/N) ',
        ]);
      });
    });
    assert.equal(options.header, "[permission] Allow write to notes\rHIDDEN.txt?");
  });
}

test("permission rendering preserves ordinary Unicode text", async () => {
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withMockedReadline(
      () => ({
        question: async (prompt) => {
          assert.equal(prompt, "Allow café 🦞? ");
          return "n";
        },
        close: () => {},
      }),
      async () => {
        assert.equal(await promptForPermission({ prompt: "Allow café 🦞? " }), false);
      },
    );
  });
});
