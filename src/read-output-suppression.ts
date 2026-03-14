export const SUPPRESSED_READ_OUTPUT = "[read output suppressed]";

export type ReadLikeToolDescriptor = {
  title?: string;
  kind?: string | null;
};

function inferToolKindFromTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const head = normalized.split(":", 1)[0]?.trim();
  if (!head) {
    return undefined;
  }

  if (
    head.includes("read") ||
    head.includes("cat") ||
    head.includes("open") ||
    head.includes("view")
  ) {
    return "read";
  }

  return undefined;
}

export function isReadLikeTool(tool: ReadLikeToolDescriptor): boolean {
  return (
    tool.kind?.trim().toLowerCase() === "read" || inferToolKindFromTitle(tool.title) === "read"
  );
}
