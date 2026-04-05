import type { OutputFormat } from "../../types.js";

export function emitJsonResult(format: OutputFormat, payload: unknown): boolean {
  if (format !== "json") {
    return false;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return true;
}
