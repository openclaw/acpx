import fs from "node:fs/promises";
import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";

export async function writePrivateSessionFile(filePath: string, content: string): Promise<void> {
  await using workspace = await tempWorkspace({
    rootDir: path.dirname(filePath),
    prefix: ".acpx-write-",
    dirMode: 0o700,
  });
  const directory = path.dirname(workspace.dir);
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
  }

  const temporaryFile = workspace.path("record.json");
  const handle = await fs.open(temporaryFile, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }

  // Stage on the same filesystem, then retain ordinary last-writer-wins rename
  // semantics without persistent locks or post-publication inode requirements.
  await fs.rename(temporaryFile, path.join(directory, path.basename(filePath)));
}
