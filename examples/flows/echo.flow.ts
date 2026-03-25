import { acp, compute, defineFlow, extractJsonObject } from "../../src/flows.js";

type EchoInput = {
  request?: string;
};

export default defineFlow({
  name: "example-echo",
  startAt: "reply",
  nodes: {
    reply: acp({
      async prompt({ input }) {
        const request = (input as EchoInput).request ?? "Say hello in one short sentence.";
        return [
          "Return exactly one JSON object with this shape:",
          "{",
          '  "reply": "short response"',
          "}",
          "",
          `Request: ${request}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    finalize: compute({
      run: ({ outputs }) => outputs.reply,
    }),
  },
  edges: [{ from: "reply", to: "finalize" }],
});
