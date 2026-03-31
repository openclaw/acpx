import { createReplayViewerServer, isServerAlreadyRunning } from "./server/viewer-server.js";

const HOST = "127.0.0.1";
const PORT = 4173;

async function main(): Promise<void> {
  const baseUrl = `http://${HOST}:${PORT}`;

  if (await isServerAlreadyRunning(baseUrl)) {
    process.stdout.write(`Viewer already running at ${baseUrl}/\n`);
    return;
  }

  const viewerServer = await createReplayViewerServer({
    host: HOST,
    port: PORT,
  });

  process.stdout.write(`Viewer running at ${viewerServer.baseUrl}/\n`);

  const close = async (): Promise<void> => {
    await viewerServer.close();
  };

  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
