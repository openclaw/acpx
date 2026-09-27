import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [harness, argLogPath, ...args] = process.argv.slice(2);
if (argLogPath) {
  appendFileSync(argLogPath, `${JSON.stringify(args)}\n`, "utf8");
}

function consumePrefix(prefix: string[]): string[] {
  if (!prefix.every((token, index) => args[index] === token)) {
    throw new Error(`Invalid ${harness} launcher arguments: expected ${prefix.join(" ")}`);
  }
  return args.slice(prefix.length);
}

function consumeStartupOptions(
  markers: string[],
  options: string[],
  allowEquals: boolean,
): string[] {
  let index = 0;
  let hasAcp = false;
  while (index < args.length) {
    const token = args[index];
    if (markers.includes(token)) {
      if (hasAcp) {
        throw new Error(`Duplicate ${harness} ACP marker`);
      }
      hasAcp = true;
      index += 1;
      continue;
    }
    if (options.includes(token)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || markers.includes(value)) {
        throw new Error(`Missing ${harness} launcher value for ${token}`);
      }
      index += 2;
      continue;
    }
    if (allowEquals && options.some((option) => token.startsWith(`${option}=`))) {
      if (token.indexOf("=") === token.length - 1) {
        throw new Error(`Missing ${harness} launcher value for ${token}`);
      }
      index += 1;
      continue;
    }
    break;
  }
  if (!hasAcp) {
    throw new Error(`Missing ${harness} ACP marker`);
  }
  return args.slice(index);
}

function mockArguments(): string[] {
  // These literals are independent of the production registry under test.
  switch (harness) {
    case "cursor-agent":
      return consumePrefix(["acp"]);
    case "droid":
      return consumePrefix(["exec", "--output-format", "acp"]);
    case "uvx":
      return consumePrefix(["fast-agent-mcp", "acp"]);
    case "iflow":
      return consumePrefix(["--experimental-acp"]);
    case "devin":
      return consumeStartupOptions(["acp", "--acp", "--experimental-acp"], ["--model"], false);
    case "qodercli":
      return consumeStartupOptions(
        ["--acp"],
        ["--max-turns", "--allowed-tools", "--disallowed-tools"],
        true,
      );
    default:
      throw new Error(`Unknown test harness: ${harness}`);
  }
}

process.argv = [
  process.execPath,
  fileURLToPath(new URL("../mock-agent.js", import.meta.url)),
  ...mockArguments(),
];
// The mock parses argv on import, after the harness-only tokens are consumed.
await import("../mock-agent.js");
