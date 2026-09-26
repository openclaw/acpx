import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const viewerModule = new URL(
  "../examples/flows/replay-viewer/server/viewer-server.js",
  import.meta.url,
).href;
const actualConfig = path.resolve("examples/flows/replay-viewer/vite.config.ts");
const controlKey = "acpx-replay-viewer-close-test";

// The compiled server's cwd fallback lets each actor use the real viewer config
// with its own cache, without adding a production configuration option.
async function prepareActor(controlled: boolean): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-close-"));
  const configDirectory = path.join(directory, "examples/flows/replay-viewer");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.mkdir(path.join(directory, "runs"));
  await fs.mkdir(path.join(directory, "tmp"));
  await fs.mkdir(path.join(directory, "home"));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(
    path.join(configDirectory, "vite.config.ts"),
    `import actual from ${JSON.stringify(actualConfig)};
const cacheDir = ${JSON.stringify(path.join(directory, ".vite"))};
${controlled ? controlledLifecycleConfig() : "export default { ...actual, cacheDir };"}
`,
  );
  return directory;
}

function controlledLifecycleConfig(): string {
  return `
const viteUrl = ${JSON.stringify(import.meta.resolve("vite"))};
const { DevEnvironment } = await import(viteUrl);
const heldSource = actual.root.replaceAll(String.fromCharCode(92), "/") + "/src/app.tsx";
const control = { admitted: false, closeCalls: 0, warmups: [], settled: 0 };
globalThis[Symbol.for(${JSON.stringify(controlKey)})] = control;
let release;
const gate = new Promise((resolve) => { release = resolve; });
let admit;
const admitted = new Promise((resolve) => { admit = resolve; });
class ClosingClientEnvironment extends DevEnvironment {
  close() {
    control.closeCalls++;
    release();
    return super.close();
  }
  warmupRequest(url) {
    const result = super.warmupRequest(url);
    if (url.includes("/.vite/deps/")) {
      control.warmups.push(result);
      result.then(() => { control.settled++; });
    }
    return result;
  }
}
export default {
  ...actual,
  cacheDir,
  plugins: [...actual.plugins, {
    name: "test-held-viewer-source",
    enforce: "pre",
    async load(id) {
      if (this.environment.mode === "dev" && this.environment.name === "client" && id === heldSource) {
        control.admitted = true;
        admit();
        await gate;
      }
      return null;
    },
    async configureServer(server) {
      control.held = server.environments.client.warmupRequest("/src/app.tsx");
      await Promise.race([
        admitted,
        control.held.then(() => { throw new Error("Viewer source did not enter the load gate"); }),
      ]);
    },
  }],
  environments: {
    client: {
      dev: {
        createEnvironment(name, config, context) {
          return new ClosingClientEnvironment(name, config, { hot: true, transport: context.ws });
        },
      },
    },
  },
};
`;
}

const actorSource = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const [moduleUrl, mode] = process.argv.slice(1);
const { createReplayViewerServer } = await import(moduleUrl);
const directory = process.cwd();
const viewer = await createReplayViewerServer({
  host: "127.0.0.1",
  port: 0,
  runsDir: path.join(directory, "runs"),
});
const control = globalThis[Symbol.for("acpx-replay-viewer-close-test")];
let optimizedImports = [];
try {
  if (mode !== "no-entry") {
    const response = await fetch(new URL("/src/main.tsx", viewer.baseUrl));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("createRoot"));
    optimizedImports = [...body.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
      .map((match) => match[1]).filter((url) => url.includes("/.vite/deps/"));
    assert.ok(optimizedImports.length > 0);
    if (mode === "consumed") {
      for (const url of optimizedImports) {
        const dependency = await fetch(new URL(url, viewer.baseUrl));
        assert.equal(dependency.status, 200);
        assert.ok((await dependency.text()).length > 0);
      }
    }
    if (mode === "held-crawl") {
      assert.equal(control.admitted, true);
      assert.ok(control.warmups.length > 0, "optimized warmups must have been admitted");
      assert.equal(control.settled, 0, "the held crawl must precede dependency completion");
    }
  }
  process.stdout.write(JSON.stringify({
    phase: "close-ready", mode,
    ...(control ? { warmups: control.warmups.length, settled: control.settled } : {}),
  }) + "\n");
} finally {
  await Promise.all([viewer.close(), viewer.close()]);
  await viewer.close();
}
if (mode === "held-crawl") {
  assert.equal(control.closeCalls, 1, "the real environment close must run exactly once");
  await control.held;
  await Promise.all(control.warmups);
  assert.equal(control.settled, control.warmups.length);
}
await fs.writeFile(path.join(directory, "closed.json"), JSON.stringify({ mode, closed: true }));
`;

async function runActor(directory: string, mode: string): Promise<void> {
  await fs.rm(path.join(directory, "closed.json"), { force: true });
  // The timeout is a failing watchdog. Success requires natural process exit,
  // both captured pipes closing, and a receipt written after the real close.
  await execFileAsync(
    process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", actorSource, viewerModule, mode],
    {
      cwd: directory,
      timeout: 45_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_048_576,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(directory, "home"),
        USERPROFILE: path.join(directory, "home"),
        TMPDIR: path.join(directory, "tmp"),
        TMP: path.join(directory, "tmp"),
        TEMP: path.join(directory, "tmp"),
        SystemRoot: process.env.SystemRoot,
      },
    },
  );
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "closed.json"), "utf8")), {
    mode,
    closed: true,
  });
}

for (const mode of ["no-entry", "immediate", "held-crawl"]) {
  test(`viewer shutdown completes after ${mode}`, { timeout: 55_000 }, async () => {
    // held-crawl controls scheduling through Vite's public plugin/environment
    // hooks. Its uninstrumented siblings exercise the ordinary viewer API.
    const directory = await prepareActor(mode === "held-crawl");
    try {
      await runActor(directory, mode);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test(
  "viewer shutdown preserves consumed modules and warm cache reuse",
  { timeout: 100_000 },
  async () => {
    const directory = await prepareActor(false);
    try {
      await runActor(directory, "consumed");
      const metadataPath = path.join(directory, ".vite/deps/_metadata.json");
      const metadata = await fs.readFile(metadataPath, "utf8");
      await runActor(directory, "consumed");
      assert.equal(await fs.readFile(metadataPath, "utf8"), metadata);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
