import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export type Source = "parent" | "session" | "runtime";
export type PeerProfile = {
  version: string;
  flag: "--acp" | "--experimental-acp" | null;
  silentInitialize?: boolean;
};
export type FixtureConfig = {
  root: string;
  agent: "gemini" | "copilot";
  relative?: boolean;
  sessionEnv: Record<string, string>;
  runtimeEnv?: Record<string, string>;
  authCredentials?: Record<string, string>;
  profiles: Record<"parent" | "session", PeerProfile> & { runtime?: PeerProfile };
};
export type PeerTrace = {
  event: "invocation" | "safety-deadline";
  source: Source;
  args: string[];
  cwd: string;
  hasGeminiKey: boolean;
  hasGoogleKey: boolean;
};
export type DriverResult = {
  initialized: boolean;
  errorName?: string;
  message?: string;
  parentUnchanged: boolean;
};

async function runClient(config: FixtureConfig): Promise<void> {
  const { AcpClient } = await import("../../src/acp/client.js");
  const parent = {
    cwd: process.cwd(),
    path: process.env.PATH,
    gemini: process.env.GEMINI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
  };
  const command = config.relative ? `./bin/${config.agent}` : config.agent;
  const argv = [command, "--acp", ...(config.agent === "copilot" ? ["--stdio"] : [])];
  const client = new AcpClient({
    agentCommand: argv.join(" "),
    agentArgv: argv,
    cwd: path.join(config.root, "workspace"),
    permissionMode: "deny-all",
    sessionOptions: { env: config.sessionEnv },
    agentProcessEnv: config.runtimeEnv,
    authCredentials: config.authCredentials,
  });
  const watchdog = setTimeout(() => {
    process.stderr.write("synthetic driver safety deadline\n");
    process.exit(94);
  }, 12_000);
  watchdog.unref();
  const result: DriverResult = { initialized: false, parentUnchanged: false };
  try {
    await client.start();
    result.initialized = true;
  } catch (error) {
    result.errorName = error instanceof Error ? error.name : "NonError";
    result.message = error instanceof Error ? error.message : "Non-error failure";
  } finally {
    await client.close();
    clearTimeout(watchdog);
  }
  result.parentUnchanged =
    process.cwd() === parent.cwd &&
    process.env.PATH === parent.path &&
    process.env.GEMINI_API_KEY === parent.gemini &&
    process.env.GOOGLE_API_KEY === parent.google;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runPeer(config: FixtureConfig, source: Source, args: string[]): void {
  const profile = config.profiles[source];
  if (!profile) {
    throw new Error("Missing synthetic peer profile");
  }
  const observation = {
    source,
    args,
    cwd: process.cwd(),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasGoogleKey: Boolean(process.env.GOOGLE_API_KEY),
  };
  const trace = (event: PeerTrace["event"]) => {
    fs.appendFileSync(
      path.join(config.root, "trace.jsonl"),
      `${JSON.stringify({ event, ...observation })}\n`,
    );
  };
  trace("invocation");
  if (args[0] === "--version") {
    process.stdout.write(`${profile.version}\n`);
    return;
  }
  if (args[0] === "--help") {
    process.stdout.write(profile.flag ? "Usage: copilot --acp --stdio\n" : "Usage: copilot\n");
    return;
  }
  if (args[0] !== profile.flag) {
    process.stderr.write(`synthetic adapter rejected flag: ${args[0]}\n`);
    process.exitCode = 2;
    return;
  }

  // No descendants: the wrapper execs this process, which exits on EOF or TERM.
  const watchdog = setTimeout(() => {
    trace("safety-deadline");
    process.exit(95);
  }, 5_000);
  watchdog.unref();
  const lines = readline.createInterface({ input: process.stdin });
  lines.once("close", () => clearTimeout(watchdog));
  lines.on("line", (line) => {
    const request = JSON.parse(line) as { id?: string | number; method?: string };
    if (request.id == null || (profile.silentInitialize && request.method === "initialize")) {
      return;
    }
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: 1,
            agentCapabilities: {},
            authMethods: [],
            agentInfo: { name: `synthetic-${source}`, version: profile.version },
          }
        : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
}

const [mode, configPath, source, ...args] = process.argv.slice(2);
if (!configPath) {
  throw new Error("Expected synthetic fixture config");
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as FixtureConfig;
if (mode === "driver") {
  await runClient(config);
} else if (
  mode === "peer" &&
  (source === "parent" || source === "session" || source === "runtime")
) {
  runPeer(config, source, args);
} else {
  throw new Error("Unexpected synthetic fixture mode");
}
