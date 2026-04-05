import { action, defineFlow, extractJsonObject, shell } from "acpx/flows";

export default defineFlow({
  name: "fixture-shell",
  startAt: "prepare",
  nodes: {
    prepare: action({
      run: ({ input }) => ({
        text: String((input as { text?: string }).text ?? "").toUpperCase(),
      }),
    }),
    run_shell: shell({
      exec: ({ outputs }) => ({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ value: process.env.FLOW_TEXT, cwd: process.cwd() }))",
        ],
        env: {
          FLOW_TEXT: String((outputs.prepare as { text: string }).text),
        },
      }),
      parse: (result) => extractJsonObject(result.stdout),
    }),
    finalize: action({
      run: ({ outputs }) => outputs.run_shell,
    }),
  },
  edges: [
    { from: "prepare", to: "run_shell" },
    { from: "run_shell", to: "finalize" },
  ],
});
