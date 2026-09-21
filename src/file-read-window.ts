export function sliceReadWindow(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) {
    return content;
  }

  const lines = content.split("\n");
  const startLine = line == null ? 1 : Math.max(1, Math.trunc(line));
  const startIndex = Math.max(0, startLine - 1);
  const maxLines = limit == null ? undefined : Math.max(0, Math.trunc(limit));

  if (maxLines === 0) {
    return "";
  }

  const endIndex = maxLines == null ? lines.length : Math.min(lines.length, startIndex + maxLines);

  return lines.slice(startIndex, endIndex).join("\n");
}
