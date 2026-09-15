import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { InvalidArgumentError } from "commander";
import {
  mergePromptSourceWithText,
  parsePromptSource,
  PromptInputValidationError,
  textPrompt,
  type PromptInput,
} from "../prompt-content.js";

export async function readPromptInput(
  filePath: string | undefined,
  promptText: string,
  cwd: string,
  positionalLabel: "argument" | "final argument" = "argument",
): Promise<PromptInput> {
  try {
    if (filePath) {
      return await readPromptFile(filePath, promptText, cwd);
    }

    const joined = promptText.trim();
    if (joined.length > 0) {
      return textPrompt(joined);
    }
    if (process.stdin.isTTY) {
      throw new InvalidArgumentError(
        `Prompt is required (pass as ${positionalLabel}, --file, or pipe via stdin)`,
      );
    }
    const prompt = parsePromptSource(await text(process.stdin));
    if (prompt.length === 0) {
      throw new InvalidArgumentError("Prompt from stdin is empty");
    }
    return prompt;
  } catch (error) {
    if (error instanceof PromptInputValidationError) {
      throw new InvalidArgumentError(error.message);
    }
    throw error;
  }
}

async function readPromptFile(
  filePath: string,
  promptText: string,
  cwd: string,
): Promise<PromptInput> {
  const source =
    filePath === "-"
      ? await text(process.stdin)
      : await fs.readFile(path.resolve(cwd, filePath), "utf8");
  const prompt = mergePromptSourceWithText(source, promptText);
  if (prompt.length === 0) {
    throw new InvalidArgumentError("Prompt from --file is empty");
  }
  return prompt;
}
