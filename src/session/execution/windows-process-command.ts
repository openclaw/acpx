import path from "node:path";

type ArgumentState = { value: string; index: number; quoted: boolean };

function readQuote(commandLine: string, state: ArgumentState, executable: boolean): void {
  if (!executable && state.quoted && commandLine[state.index + 1] === '"') {
    state.value += '"';
    state.index += 2;
  } else {
    state.quoted = !state.quoted;
    state.index += 1;
  }
}

function readBackslashes(commandLine: string, state: ArgumentState, executable: boolean): void {
  const start = state.index;
  while (commandLine[state.index] === "\\") {
    state.index += 1;
  }
  const count = state.index - start;
  if (executable || commandLine[state.index] !== '"') {
    state.value += "\\".repeat(count);
  } else {
    state.value += "\\".repeat(Math.floor(count / 2));
    if (count % 2 === 1) {
      state.value += '"';
      state.index += 1;
    } else {
      readQuote(commandLine, state, false);
    }
  }
}

function readArgument(
  commandLine: string,
  start: number,
  executable: boolean,
): ArgumentState | undefined {
  const state = { value: "", index: start, quoted: false };
  while (state.index < commandLine.length) {
    const char = commandLine[state.index];
    if (!state.quoted && /[ \t]/u.test(char)) {
      break;
    }
    if (char === "\\") {
      readBackslashes(commandLine, state, executable);
    } else if (char === '"') {
      readQuote(commandLine, state, executable);
    } else {
      state.value += char;
      state.index += 1;
    }
  }
  // Native argv launches are balanced. Incomplete observations grant no signal authority.
  return state.quoted ? undefined : state;
}

function readBatchCommand(commandLine: string): string | undefined {
  const body = commandLine.match(/^[ \t]+\/d[ \t]+\/s[ \t]+\/c[ \t]+"([\s\S]*)"$/iu)?.[1];
  if (!body) {
    return undefined;
  }
  let command = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "^") {
      index += 1;
      if (index === body.length) {
        return undefined;
      }
      command += body[index];
    } else if (/[ \t]/u.test(char)) {
      break;
    } else if (/["\r\n]/u.test(char)) {
      return undefined;
    } else {
      command += char;
    }
  }
  return /\.(?:cmd|bat)$/iu.test(command) ? command : undefined;
}

/** Decode process observations, not saved command identities or POSIX launch strings. */
export function splitWindowsProcessCommandLine(commandLine: string): string[] {
  const line = commandLine.trim();
  const executable = readArgument(line, 0, true);
  if (!executable?.value) {
    return [];
  }
  const argv = [executable.value];
  if (path.win32.basename(executable.value).toLowerCase() === "cmd.exe") {
    // buildAgentSpawnCommand uses verbatim /d /s /c plus one outer-quoted body.
    // Its caret-escaped batch path is a cmd token, not a CRT argument.
    const batch = readBatchCommand(line.slice(executable.index));
    return batch ? [...argv, batch] : argv;
  }
  let rest = line.slice(executable.index).trimStart();
  while (rest) {
    const argument = readArgument(rest, 0, false);
    if (!argument) {
      return [];
    }
    argv.push(argument.value);
    rest = rest.slice(argument.index).trimStart();
  }
  return argv;
}
