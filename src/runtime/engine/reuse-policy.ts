import path from "node:path";
import type { SessionRecord } from "../../types.js";

export function shouldReuseExistingRecord(
  record: Pick<SessionRecord, "cwd" | "agentCommand" | "acpSessionId" | "acpx">,
  params: {
    cwd: string;
    agentCommand: string;
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
  if (params.resumeSessionId && record.acpSessionId !== params.resumeSessionId) {
    return false;
  }
  return true;
}
