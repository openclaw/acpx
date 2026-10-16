import readline from "node:readline/promises";

export type PermissionPromptOptions = {
  prompt: string;
  header?: string;
  details?: string;
  signal?: AbortSignal;
};

function visiblePromptText(value: string): string {
  let rendered = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      rendered += `\\x${codePoint.toString(16).padStart(2, "0")}`;
      continue;
    }
    rendered += character;
  }
  return rendered;
}

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

function promptForDisplay(prompt: string): string {
  // Templates start with a newline. Escape every control in the text after it.
  if (prompt.startsWith("\n")) {
    return `\n${visiblePromptText(prompt.slice(1))}`;
  }
  return visiblePromptText(prompt);
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
    const answer = await Promise.race([
      rl.question(promptForDisplay(options.prompt), { signal }),
      closed,
    ]);
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
    process.stderr.write(`\n${visiblePromptText(options.header)}\n`);
  }
  if (options.details && options.details.trim().length > 0) {
    process.stderr.write(`${options.details.split("\n").map(visiblePromptText).join("\n")}\n`);
  }
}
