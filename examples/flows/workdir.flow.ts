import { acp, compute, defineFlow, extractJsonObject, shell } from "acpx/flows";

export default defineFlow({
  name: "example-workdir",
  startAt: "prepare_workspace",
  nodes: {
    prepare_workspace: shell({
      exec: () => ({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs/promises');",
            "const os = require('node:os');",
            "const path = require('node:path');",
            "(async () => {",
            "  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-flow-workdir-'));",
            "  await fs.writeFile(path.join(workdir, 'note.txt'), 'hello from isolated workspace\\n', 'utf8');",
            "  process.stdout.write(JSON.stringify({ workdir }));",
            "})().catch((error) => {",
            "  console.error(error);",
            "  process.exitCode = 1;",
            "});",
          ].join(" "),
        ],
      }),
      parse: (result) => extractJsonObject(result.stdout),
      statusDetail: "Create isolated workspace for later ACP steps",
    }),
    inspect_workspace: acp({
      cwd: ({ outputs }) => (outputs.prepare_workspace as { workdir: string }).workdir,
      async prompt() {
        return [
          "You are already inside an isolated workspace created by the flow runtime.",
          "Read note.txt from the current working directory and return exactly one JSON object with this shape:",
          "{",
          '  "cwd": "current working directory",',
          '  "note": "contents of note.txt"',
          "}",
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),
    finalize: compute({
      run: ({ outputs }) => outputs.inspect_workspace,
    }),
  },
  edges: [
    { from: "prepare_workspace", to: "inspect_workspace" },
    { from: "inspect_workspace", to: "finalize" },
  ],
});
