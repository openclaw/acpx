import { action, checkpoint, defineFlow } from "acpx/flows";

export default defineFlow({
  name: "fixture-wait",
  startAt: "prepare",
  nodes: {
    prepare: action({
      run: ({ input }) => ({
        ticket: String((input as { ticket?: string }).ticket ?? "review"),
      }),
    }),
    wait_for_human: checkpoint({
      summary: "needs review",
      run: ({ outputs }) => ({
        checkpoint: "wait_for_human",
        summary: `review ${(outputs.prepare as { ticket: string }).ticket}`,
      }),
    }),
    unreachable: action({
      run: () => ({ ok: false }),
    }),
  },
  edges: [
    { from: "prepare", to: "wait_for_human" },
    { from: "wait_for_human", to: "unreachable" },
  ],
});
