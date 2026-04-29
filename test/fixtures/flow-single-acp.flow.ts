import { acp, defineFlow, extractJsonObject } from "acpx/flows";

export default defineFlow({
  name: "fixture-single-acp",
  startAt: "only",
  nodes: {
    only: acp({
      async prompt() {
        return 'echo {"ok":true}';
      },
      parse: (text) => extractJsonObject(text),
    }),
  },
  edges: [],
});
