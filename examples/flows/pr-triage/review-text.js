export function selectLocalCodexReviewText(stdout, stderr) {
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

export function extractCodexReviewTail(text) {
  const rawLines = text.split("\n");
  const assistantMarkerIndex = rawLines.findLastIndex((line) => /^codex\s*$/i.test(line));
  if (assistantMarkerIndex >= 0) {
    const assistantTail = rawLines
      .slice(assistantMarkerIndex + 1)
      .join("\n")
      .trim();
    if (assistantTail) {
      return assistantTail;
    }
  }

  const lines = rawLines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }

  const tail = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (
      line === "exec" ||
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
