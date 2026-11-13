import fs from "node:fs/promises";

// Map the read error itself instead of a stat() pre-check, so pipes such as `--file <(cmd)` still work.
export async function readCliInputFile(resolvedPath: string, label: string): Promise<string> {
  try {
    return await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`${label} not found: ${resolvedPath}`, { cause: error });
    }
    if (code === "EISDIR") {
      throw new Error(`${label} is not a file: ${resolvedPath}`, { cause: error });
    }
    throw error;
  }
}
