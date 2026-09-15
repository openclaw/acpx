import { acp, defineFlow } from "acpx/flows";

export default defineFlow({
  name: "fixture-session-turn",
  startAt: "hold",
  nodes: {
    hold: acp({ prompt: () => "stream-sleep 2500 flow-held" }),
  },
  edges: [],
});
