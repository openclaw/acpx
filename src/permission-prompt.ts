import readline from "node:readline/promises";

export type PermissionPromptOptions = {
  prompt: string;
  header?: string;
  details?: string;
  signal?: AbortSignal;
};

let promptQueue: Promise<void> = Promise.resolve();

export async function promptForPermission(options: PermissionPromptOptions): Promise<boolean> {
  options.signal?.throwIfAborted();
  const result = promptQueue.then(() => askPermission(options));
  // A cancelled waiter must not release its slot while the previous question is still active.
  promptQueue = result.then(
    () => {},
    () => {},
  );
  const signal = options.signal;
  if (!signal) {
    return await result;
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([result, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function askPermission(options: PermissionPromptOptions): Promise<boolean> {
  options.signal?.throwIfAborted();
  if (!canPrompt()) {
    return false;
  }
  writePromptDetails(options);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const questionController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, questionController.signal])
    : questionController.signal;

  let onClose: () => void = () => {};
  const closed = new Promise<undefined>((resolve) => {
    onClose = () => resolve(undefined);
    rl.once("close", onClose);
  });
  try {
    const answer = await Promise.race([rl.question(options.prompt, { signal }), closed]);
    options.signal?.throwIfAborted();
    const normalized = answer?.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.removeListener("close", onClose);
    questionController.abort();
    rl.close();
  }
}

function canPrompt(): boolean {
  return (
    process.stdin.isTTY &&
    process.stderr.isTTY &&
    !process.stdin.readableEnded &&
    !process.stdin.destroyed
  );
}

function writePromptDetails(options: PermissionPromptOptions): void {
  if (options.header) {
    process.stderr.write(`\n${options.header}\n`);
  }
  if (options.details && options.details.trim().length > 0) {
    process.stderr.write(`${options.details}\n`);
  }
}
