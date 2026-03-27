export function selectLocalCodexReviewText(stdout: string, stderr: string): string {
  const stdoutText = String(stdout ?? "").trim();
  const stderrText = String(stderr ?? "").trim();

  if (stdoutText) {
    return stdoutText;
  }
  if (!stderrText) {
    return "";
  }

  const extractedTail = extractCodexReviewTail(stderrText);
  return extractedTail || stderrText;
}

export function extractCodexReviewTail(text: string): string {
  const codexTailMatch = text.match(/(?:^|\n)codex\s*\n([\s\S]+)$/i);
  if (codexTailMatch?.[1]?.trim()) {
    return codexTailMatch[1].trim();
  }

  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }

  const tail: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (
      line.startsWith("exec") ||
      line.startsWith("/bin/") ||
      /^\d{4}-\d{2}-\d{2}T/.test(line) ||
      line === "codex"
    ) {
      break;
    }
    tail.unshift(line);
  }

  return tail.join("\n").trim();
}
