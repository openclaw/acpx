import fs from "node:fs/promises";
import path from "node:path";
import { tempFile } from "@openclaw/fs-safe/advanced";

export async function writePrivateFile(
  filePath: string,
  content: string | Uint8Array,
  options: { privateDirectory?: boolean } = {},
): Promise<void> {
  const privateDirectory = options.privateDirectory !== false;
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: privateDirectory ? 0o700 : undefined,
  });
  const directory = await fs.realpath(path.dirname(filePath));
  if (privateDirectory && process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
  }
  await using temporary = await tempFile({
    rootDir: directory,
    prefix: "acpx-write",
    fileName: "record.json",
  });
  const handle = await fs.open(temporary.path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }

  // Stage on the same filesystem, then retain ordinary last-writer-wins rename
  // semantics without persistent locks or post-publication inode requirements.
  await fs.rename(temporary.path, path.join(directory, path.basename(filePath)));
}

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
