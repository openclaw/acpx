import assert from "node:assert/strict";
import test from "node:test";
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
