export function humanizeIdentifier(value: string): string {
  const normalized = value
    .replace(/[_-]+/g, " ")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bacp\b/gi, "ACP")
    .trim();

  if (!normalized) {
    return value;
  }

  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs == null || Number.isNaN(durationMs)) {
    return "n/a";
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) {
    return "n/a";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
