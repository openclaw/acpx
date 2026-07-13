import { randomUUID } from "node:crypto";

export function createAtomicWriteTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}
