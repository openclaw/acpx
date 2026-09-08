type ShellOutputStream = "stdout" | "stderr";

export function validateShellActionMaxBufferBytes(value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Shell action maxBufferBytes must be a non-negative safe integer");
  }
}

export function createShellOutputCapture(
  maxBufferBytes: number | undefined,
  inactive: () => boolean,
  overflow: (error: Error) => void,
) {
  const output = { stdout: "", stderr: "" };
  const bytes = { stdout: 0, stderr: 0 };
  return {
    output,
    append(stream: ShellOutputStream, chunk: string): void {
      if (inactive()) {
        return;
      }
      if (maxBufferBytes !== undefined) {
        bytes[stream] += Buffer.byteLength(chunk, "utf8");
        if (bytes[stream] > maxBufferBytes) {
          overflow(
            new Error(`Shell action exceeded maxBuffer (${maxBufferBytes} bytes) on ${stream}`),
          );
          return;
        }
      }
      output[stream] += chunk;
    },
  };
}
