import { defineFlow, extractJsonObject, shell } from "acpx/flows";

export default defineFlow({
  name: "fixture-interrupt",
  startAt: "slow",
  nodes: {
    slow: shell({
      heartbeatMs: 25,
      exec: () => ({
        command: process.execPath,
        args: [
          "-e",
          "setTimeout(() => process.stdout.write(JSON.stringify({ done: true })), 10_000)",
        ],
      }),
      parse: (result) => extractJsonObject(result.stdout),
    }),
  },
  edges: [],
});
