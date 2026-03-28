import { compute, defineFlow, extractJsonObject, shell } from "../../src/flows.js";

type ShellInput = {
  text?: string;
};

export default defineFlow({
  name: "example-shell",
  startAt: "transform",
  nodes: {
    transform: shell({
      async exec({ input }) {
        const text = (input as ShellInput).text ?? "hello from shell";
        return {
          command: process.execPath,
          args: [
            "-e",
            `process.stdout.write(JSON.stringify({ original: ${JSON.stringify(text)}, upper: ${JSON.stringify(text.toUpperCase())} }))`,
          ],
        };
      },
      parse: (result) => extractJsonObject(result.stdout),
      statusDetail: "Run native shell-backed action",
    }),
    finalize: compute({
      run: ({ outputs }) => outputs.transform,
    }),
  },
  edges: [{ from: "transform", to: "finalize" }],
});
