import { acp, checkpoint, decision, decisionEdge, defineFlow, extractJsonObject } from "acpx/flows";

type BranchInput = {
  task?: string;
};

const classifyChoices = ["continue", "checkpoint"] as const;

export default defineFlow({
  name: "example-branch",
  startAt: "classify",
  nodes: {
    classify: decision({
      choices: classifyChoices,
      question: ({ input }) => {
        const task =
          (input as BranchInput).task ??
          "Investigate a flaky test and decide whether the request is clear enough to continue.";
        return [
          "Read the task below.",
          "Pick `continue` if it is concrete and scoped.",
          "Pick `checkpoint` if it is ambiguous or needs clarification.",
          "",
          `Task: ${task}`,
        ].join("\n");
      },
    }),
    continue_lane: acp({
      async prompt({ outputs }) {
        return [
          "We are on the continue path.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "route": "continue",',
          '  "summary": "short explanation"',
          "}",
          "",
          `Decision: ${JSON.stringify(outputs.classify)}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    checkpoint_lane: checkpoint({
      summary: "needs clarification",
      run: ({ outputs }) => ({
        route: "checkpoint",
        summary: (outputs.classify as { reason?: string }).reason ?? "Needs clarification.",
      }),
    }),
  },
  edges: [
    decisionEdge({
      from: "classify",
      choices: classifyChoices,
      cases: {
        continue: "continue_lane",
        checkpoint: "checkpoint_lane",
      },
    }),
  ],
});
