import path from "node:path";
import type { SessionRecord } from "../../types.js";

export function shouldReuseExistingRecord(
  record: Pick<SessionRecord, "cwd" | "agentCommand" | "agentArgv" | "acpSessionId" | "acpx">,
  params: {
    cwd: string;
    agentCommand: string;
    agentArgv?: string[];
    resumeSessionId?: string;
  },
): boolean {
  if (record.acpx?.reset_on_next_ensure === true) {
    return false;
  }
  if (path.resolve(record.cwd) !== path.resolve(params.cwd)) {
    return false;
  }
  if (record.agentCommand !== params.agentCommand) {
    return false;
  }
  if (!sameArgv(record.agentArgv, params.agentArgv)) {
    return false;
  }
  if (params.resumeSessionId && record.acpSessionId !== params.resumeSessionId) {
    return false;
  }
  return true;
}

function sameArgv(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftValues = left ?? [];
  const rightValues = right ?? [];
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}
