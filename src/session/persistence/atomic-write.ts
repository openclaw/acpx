import { randomUUID } from "node:crypto";
import path from "node:path";

export function createAtomicWriteTempPath(
  filePath: string,
  createUniqueId: () => string = randomUUID,
): string {
  const tempName = `.acpx-write.${process.pid}.${Date.now()}.${createUniqueId()}.tmp`;
  return path.join(path.dirname(filePath), tempName);
}
