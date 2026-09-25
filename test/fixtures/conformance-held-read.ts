import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const originalOpen = fs.open;
const target = process.env.ACPX_CONFORMANCE_HELD_TARGET;
const marker = process.env.ACPX_CONFORMANCE_HELD_MARKER;
const nonce = process.env.ACPX_CONFORMANCE_HELD_NONCE;
fs.open = async (...args) => {
  if (target && marker && nonce && args[0] === target) {
    await fs.writeFile(marker, JSON.stringify({ pid: process.pid, target, nonce }));
    // Hold before opening an FD; a pending Promise alone does not keep Node alive.
    return await new Promise<Awaited<ReturnType<typeof originalOpen>>>(() => {});
  }
  return await originalOpen(...args);
};
syncBuiltinESMExports();
