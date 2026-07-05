import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetPlatform = process.env.npm_config_platform ?? process.platform;
const targetArch = process.env.npm_config_arch ?? process.arch;

if (targetPlatform !== "darwin" && targetPlatform !== "linux") {
  process.exit(0);
}

if (targetPlatform !== process.platform) {
  console.warn(
    `[acpx] skipping ${targetPlatform} lifeline helper build on ${process.platform} host`,
  );
  process.exit(0);
}

if (targetArch !== process.arch) {
  console.warn(
    `[acpx] skipping ${targetPlatform}-${targetArch} lifeline helper build on ${process.arch} host`,
  );
  process.exit(0);
}

const cc = process.env.CC ?? "cc";
const source = path.join(repoRoot, "native", "lifeline.c");
const outDir = path.join(repoRoot, "dist", "native");
const output = path.join(outDir, `lifeline-${targetPlatform}-${targetArch}`);

mkdirSync(outDir, { recursive: true });

const result = spawnSync(cc, ["-O2", source, "-o", output], {
  stdio: "inherit",
});

if (result.error) {
  const code = "code" in result.error ? result.error.code : undefined;
  if (code === "ENOENT") {
    console.warn(`[acpx] skipping ${targetPlatform} lifeline helper build: cc not found`);
    process.exit(0);
  }
  throw result.error;
}

process.exit(result.status ?? 1);
