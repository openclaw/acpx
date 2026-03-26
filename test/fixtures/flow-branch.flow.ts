import { extractJsonObject } from "../../src/flows/json.js";
import { acp, compute, defineFlow } from "../../src/flows/runtime.js";

export default defineFlow({
  name: "fixture-branch",
  startAt: "first",
  nodes: {
    first: acp({
      async prompt({ input }) {
        return `echo ${JSON.stringify({ next: (input as { next: string }).next, turn: 1 })}`;
      },
      parse: (text) => extractJsonObject(text),
    }),
    second: acp({
      async prompt() {
        return 'echo {"turn":2}';
      },
      parse: (text) => extractJsonObject(text),
    }),
    route: compute({
      run: ({ input }) => ({
        next: (input as { next: string }).next,
      }),
    }),
    yes_path: compute({
      run: () => ({ ok: true }),
    }),
    no_path: compute({
      run: () => ({ ok: false }),
    }),
  },
  edges: [
    { from: "first", to: "second" },
    { from: "second", to: "route" },
    {
      from: "route",
      switch: {
        on: "$.next",
        cases: {
          yes_path: "yes_path",
          no_path: "no_path",
        },
      },
    },
  ],
});
