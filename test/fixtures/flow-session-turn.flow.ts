import { acp, defineFlow } from "acpx/flows";

export default defineFlow({
  name: "fixture-session-turn",
  startAt: "hold",
  nodes: {
    hold: acp({
      prompt: () => {
        const releaseFile = process.env.ACPX_TEST_SESSION_TURN_RELEASE;
        if (!releaseFile) {
          throw new Error("Missing session-turn release barrier");
        }
        return `stream-wait-file ${releaseFile}`;
      },
    }),
  },
  edges: [],
});
