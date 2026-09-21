import { once } from "node:events";
import { isAcpJsonRpcMessage, parsePromptStopReason } from "../acp/jsonrpc.js";
import type { SessionWatchEvent } from "../session/journal.js";
import { watchSession } from "../session/watch.js";
import type { OutputFormatter, OutputPolicy, SessionRecord } from "../types.js";
import { JsonMessageSanitizer } from "./output/json-formatter.js";
import { createOutputFormatter } from "./output/output.js";

function watchRenderer(policy: OutputPolicy): (event: SessionWatchEvent) => string[] {
  const chunks: string[] = [];
  const stdout = {
    write: (chunk: string) => {
      chunks.push(chunk);
    },
  };
  let sanitizer = new JsonMessageSanitizer(policy.suppressReads, true);
  let formatter = createOutputFormatter(policy.format, { stdout });
  return (event) => {
    chunks.length = 0;
    if (event.type === "turn_started") {
      sanitizer = new JsonMessageSanitizer(policy.suppressReads, true);
      formatter = createOutputFormatter(policy.format, { stdout });
    }
    if (policy.format === "json") {
      chunks.push(
        JSON.stringify(
          event.type === "message"
            ? { ...event, message: sanitizer.sanitize(event.message) }
            : event,
        ) + "\n",
      );
    } else if (event.type === "message") {
      renderWatchMessage(event, sanitizer, formatter, policy.format === "quiet");
    } else {
      if (event.type === "turn_result") {
        formatter.flush();
      }
      if (policy.format !== "quiet") {
        chunks.push(watchLifecycleLine(event));
      }
    }
    return chunks;
  };
}

function renderWatchMessage(
  event: Extract<SessionWatchEvent, { type: "message" }>,
  sanitizer: JsonMessageSanitizer,
  formatter: OutputFormatter,
  quiet: boolean,
): void {
  const message = sanitizer.sanitize(event.message);
  if (!isAcpJsonRpcMessage(message)) {
    throw new Error("Invalid sanitized session message");
  }
  if (quiet || parsePromptStopReason(message) === undefined) {
    formatter.onAcpMessage(message);
  }
}

function watchLifecycleLine(event: Exclude<SessionWatchEvent, { type: "message" }>): string {
  if (event.type === "turn_started") {
    return `\n[${event.requestId}] started cursor=${event.cursor}\n`;
  }
  const detail =
    event.result.status === "failed" ? event.result.error.message : event.result.stopReason;
  return `\n[${event.requestId}] ${event.result.status}${detail ? `: ${detail}` : ""} cursor=${event.cursor}\n`;
}

export async function runSessionWatch(
  record: SessionRecord,
  options: { cursor?: string; policy: OutputPolicy },
): Promise<void> {
  const stopped = new AbortController();
  let outputError: Error | undefined;
  const stop = () => stopped.abort();
  const onOutputError = (error: Error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
      outputError = error;
    }
    stop();
  };
  const render = watchRenderer(options.policy);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  process.stdout.on("error", onOutputError);
  try {
    for await (const event of watchSession({
      record,
      cursor: options.cursor,
      signal: stopped.signal,
    })) {
      for (const chunk of render(event)) {
        if (stopped.signal.aborted) {
          break;
        }
        if (!process.stdout.write(chunk)) {
          await once(process.stdout, "drain", { signal: stopped.signal });
        }
      }
    }
  } catch (error) {
    if (!stopped.signal.aborted) {
      throw error;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    process.stdout.off("error", onOutputError);
  }
  if (outputError) {
    throw outputError;
  }
}
