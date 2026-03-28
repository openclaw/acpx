import { acp, compute, defineFlow, extractJsonObject } from "../../src/flows.js";

type TwoTurnInput = {
  topic?: string;
};

export default defineFlow({
  name: "example-two-turn",
  startAt: "draft",
  nodes: {
    draft: acp({
      async prompt({ input }) {
        const topic = (input as TwoTurnInput).topic ?? "How should we validate a new ACP adapter?";
        return [
          "Write a short draft answer about the topic below.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "draft": "short paragraph"',
          "}",
          "",
          `Topic: ${topic}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    refine: acp({
      async prompt({ outputs }) {
        return [
          "Use the earlier draft already in this session.",
          "Turn it into a concise checklist.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "checklist": ["item", "item"]',
          "}",
          "",
          `Draft: ${JSON.stringify(outputs.draft)}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    finalize: compute({
      run: ({ outputs }) => outputs.refine,
    }),
  },
  edges: [
    { from: "draft", to: "refine" },
    { from: "refine", to: "finalize" },
  ],
});
