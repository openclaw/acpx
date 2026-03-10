import readline from "node:readline/promises";

type TtyState = {
  stdin: boolean;
  stderr: boolean;
};

type MockReadline = {
  question: (prompt: string) => Promise<string>;
  close: () => void;
};

function restoreDescriptor(
  target: object,
  key: "isTTY",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  delete (target as { isTTY?: boolean }).isTTY;
}

export async function withTtyState<T>(tty: TtyState, run: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: tty.stderr, configurable: true });

  try {
    return await run();
  } finally {
    restoreDescriptor(process.stdin, "isTTY", stdinDescriptor);
    restoreDescriptor(process.stderr, "isTTY", stderrDescriptor);
  }
}

export async function withMockedReadline<T>(
  factory: () => MockReadline,
  run: () => Promise<T>,
): Promise<T> {
  const originalCreateInterface = readline.createInterface;
  (
    readline as unknown as {
      createInterface: typeof readline.createInterface;
    }
  ).createInterface = factory as unknown as typeof readline.createInterface;

  try {
    return await run();
  } finally {
    (
      readline as unknown as {
        createInterface: typeof readline.createInterface;
      }
    ).createInterface = originalCreateInterface;
  }
}

export async function withCapturedStderrWrites<T>(
  run: (writes: string[]) => Promise<T>,
): Promise<T> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const writes: string[] = [];
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
    chunk: string,
  ) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    return await run(writes);
  } finally {
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
  }
}
