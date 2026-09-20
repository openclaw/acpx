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

  const head = normalized.split(/[:\s]/, 1)[0];
  if (!head) {
    return undefined;
  }

  if (["read", "cat", "open", "view"].includes(head)) {
    return "read";
  }

  return undefined;
}

export function isReadLikeTool(tool: ReadLikeToolDescriptor): boolean {
  return (
    tool.kind?.trim().toLowerCase() === "read" || inferToolKindFromTitle(tool.title) === "read"
  );
}
