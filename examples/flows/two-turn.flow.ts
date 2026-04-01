import { acp, compute, defineFlow, extractJsonObject } from "../../src/flows.js";

type TwoTurnInput = {
  topic?: string;
};

export default defineFlow({
  name: "example-two-turn",
  startAt: "inspect_workspace",
  nodes: {
    inspect_workspace: acp({
      async prompt({ input }) {
        const topic =
          (input as TwoTurnInput).topic ??
          "How should we validate a new ACP adapter before we ship it?";
        return [
          "You are in the repository root.",
          "Before answering, use at least two workspace tool calls to inspect the repo.",
          "Read package.json and at least one docs or src file relevant to the topic.",
          "Then return exactly one JSON object with this shape:",
          "{",
          '  "findings": ["short finding", "short finding"],',
          '  "repoSummary": "short paragraph"',
          "}",
          "",
          `Topic: ${topic}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    draft: acp({
      async prompt({ outputs }) {
        return [
          "Stay in the same ACP session and build on the earlier workspace inspection.",
          "Before answering, use at least one more workspace tool call to verify or deepen the findings.",
          "Write a short draft answer about the topic below.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "draft": "short paragraph"',
          "}",
          "",
          `Topic: ${JSON.stringify(outputs.inspect_workspace)}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    checklist: acp({
      async prompt({ outputs }) {
        return [
          "Use the earlier inspection and draft already in this session.",
          "Before answering, use at least one more workspace tool call to verify a concrete detail.",
          "Turn the draft into a concise validation checklist.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "checklist": ["item", "item"],',
          '  "references": ["path", "path"]',
          "}",
          "",
          `Inspection: ${JSON.stringify(outputs.inspect_workspace)}`,
          `Draft: ${JSON.stringify(outputs.draft)}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    polish: acp({
      async prompt({ outputs }) {
        return [
          "Use the same session and all previous work.",
          "Write a polished short answer and a final recommendation.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "answer": "short paragraph",',
          '  "recommendation": "short sentence"',
          "}",
          "",
          `Checklist: ${JSON.stringify(outputs.checklist)}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    finalize: compute({
      run: ({ outputs }) => ({
        inspection: outputs.inspect_workspace,
        draft: outputs.draft,
        checklist: outputs.checklist,
        final: outputs.polish,
      }),
    }),
  },
  edges: [
    { from: "inspect_workspace", to: "draft" },
    { from: "draft", to: "checklist" },
    { from: "checklist", to: "polish" },
    { from: "polish", to: "finalize" },
  ],
});
