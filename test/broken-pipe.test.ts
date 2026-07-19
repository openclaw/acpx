import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleBrokenPipeError } from "../src/cli/broken-pipe.js";

describe("handleBrokenPipeError", () => {
  it("ignores a detached queue owner's broken stderr pipe", () => {
    let exitCode: number | undefined;
    handleBrokenPipeError(
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
      "ignore",
      (code) => {
        exitCode = code;
      },
    );
    assert.equal(exitCode, undefined);
  });

  it("preserves the ordinary CLI broken-pipe exit behavior", () => {
    let exitCode: number | undefined;
    handleBrokenPipeError(
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
      "exit",
      (code) => {
        exitCode = code;
      },
    );
    assert.equal(exitCode, 0);
  });

  it("does not hide unrelated stream errors", () => {
    const error = Object.assign(new Error("stream failed"), { code: "EIO" });
    assert.throws(() => handleBrokenPipeError(error, "ignore"), error);
  });
});
