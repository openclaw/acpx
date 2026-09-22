import { Command } from "commander";
import { parseNonEmptyValue, parseOutputFormat, parseTimeoutSeconds } from "./flags.js";

export function addCompareOptions(command: Command): Command {
  return command
    .option("--cwd <dir>", "Target workspace")
    .option("--approve-all", "Auto-approve all permission requests")
    .option("--approve-reads", "Auto-approve read/search requests and prompt for writes")
    .option("--deny-all", "Deny all permission requests")
    .option("--timeout <seconds>", "Per-agent timeout in seconds", parseTimeoutSeconds)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option("--json", "Alias for --format json")
    .option(
      "-f, --file <path>",
      "Read prompt text from file path (use - for stdin)",
      (value: string) => parseNonEmptyValue("Prompt file", value),
    )
    .option("--prompt-file <path>", "Alias for --file", (value: string) =>
      parseNonEmptyValue("Prompt file", value),
    );
}

const VALUE_FLAGS = new Set(
  addCompareOptions(new Command())
    .options.filter((option) => option.required)
    .flatMap((option) => [option.long, option.short].filter((flag) => flag !== undefined)),
);

type CompareOutputFlags = { format?: string; json?: true };

function captureCompareOutputFlag(
  output: CompareOutputFlags,
  token: string,
  nextToken: string | undefined,
): void {
  if (token === "--json") {
    output.json = true;
  } else if (token === "--format") {
    output.format = nextToken;
  } else if (token.startsWith("--format=")) {
    output.format = token.slice("--format=".length);
  }
}

export function scanCompareArgs(
  argv: string[],
): CompareOutputFlags & { cwd?: string; promptTokens?: string[] } {
  let cwd: string | undefined;
  const output: CompareOutputFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      return { cwd, ...output, promptTokens: argv.slice(index + 1) };
    }
    if (token === "--cwd") {
      cwd = argv[index + 1];
    } else if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
    }
    captureCompareOutputFlag(output, token, argv[index + 1]);
    if (VALUE_FLAGS.has(token)) {
      index += 1;
    }
  }
  return { cwd, ...output };
}
