import { QueueProtocolError } from "../../errors.js";

export function queueRequestByteLimit(
  raw = process.env.ACPX_QUEUE_MAX_REQUEST_BYTES,
): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0 || !/^\d+$/.test(raw.trim())) {
    throw new Error(
      "ACPX_QUEUE_MAX_REQUEST_BYTES must be a non-negative safe integer; zero is unlimited",
    );
  }
  return limit || undefined;
}

export function queueRequestExceedsLimit(line: string, limit: number | undefined): boolean {
  return limit !== undefined && Buffer.byteLength(line, "utf8") > limit;
}

export function assertQueueRequestSize(line: string): void {
  const limit = queueRequestByteLimit();
  if (queueRequestExceedsLimit(line, limit)) {
    throw new QueueProtocolError(
      `Queue request exceeded ACPX_QUEUE_MAX_REQUEST_BYTES (${limit} bytes); raise or unset the limit`,
      {
        detailCode: "QUEUE_REQUEST_TOO_LARGE",
        origin: "queue",
        retryable: false,
      },
    );
  }
}
