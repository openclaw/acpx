import { acp, checkpoint, defineFlow, extractJsonObject } from "acpx/flows";

type BranchInput = {
  task?: string;
};

export default defineFlow({
  name: "example-branch",
  startAt: "classify",
  nodes: {
    classify: acp({
      async prompt({ input }) {
        const task =
          (input as BranchInput).task ??
          "Investigate a flaky test and decide whether the request is clear enough to continue.";
        return [
          "Read the task below.",
          "If it is concrete and scoped, route `continue`.",
          "If it is ambiguous or needs clarification, route `checkpoint`.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "route": "continue" | "checkpoint",',
          '  "reason": "short explanation"',
          "}",
          "",
          `Task: ${task}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
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
    {
      from: "classify",
      switch: {
        on: "$.route",
        cases: {
          continue: "continue_lane",
          checkpoint: "checkpoint_lane",
        },
      },
    },
  ],
});
