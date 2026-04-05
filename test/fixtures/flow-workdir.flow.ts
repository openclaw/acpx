import { acp, compute, defineFlow, extractJsonObject, shell } from "acpx/flows";

export default defineFlow({
  name: "fixture-workdir",
  startAt: "prepare",
  nodes: {
    prepare: shell({
      exec: () => ({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs/promises');",
            "const os = require('node:os');",
            "const path = require('node:path');",
            "(async () => {",
            "  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-fixture-workdir-'));",
            "  process.stdout.write(JSON.stringify({ workdir }));",
            "})().catch((error) => {",
            "  console.error(error);",
            "  process.exitCode = 1;",
            "});",
          ].join(" "),
        ],
      }),
      parse: (result) => extractJsonObject(result.stdout),
    }),
    inspect: acp({
      cwd: ({ outputs }) => (outputs.prepare as { workdir: string }).workdir,
      prompt: () => {
        const script = "process.stdout.write(JSON.stringify({ cwd: process.cwd() }))";
        return `terminal ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
      },
      parse: (text) => extractJsonObject(text),
    }),
    finalize: compute({
      run: ({ outputs }) => outputs.inspect,
    }),
  },
  edges: [
    { from: "prepare", to: "inspect" },
    { from: "inspect", to: "finalize" },
  ],
});
