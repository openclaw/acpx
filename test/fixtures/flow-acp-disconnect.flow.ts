import { acp, defineFlow } from "../../src/flows/runtime.js";

export default defineFlow({
  name: "fixture-acp-disconnect",
  startAt: "slow",
  nodes: {
    slow: acp({
      timeoutMs: 60_000,
      heartbeatMs: 25,
      async prompt() {
        return "disconnect 100";
      },
    }),
  },
  edges: [],
});
