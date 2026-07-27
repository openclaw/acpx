import { randomUUID } from "node:crypto";

export function createAtomicWriteTempPath(
  filePath: string,
  createUniqueId: () => string = randomUUID,
): string {
  return `${filePath}.${process.pid}.${Date.now()}.${createUniqueId()}.tmp`;
}
