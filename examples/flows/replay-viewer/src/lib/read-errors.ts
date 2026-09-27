export function isPathMismatchError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "path-mismatch";
}
