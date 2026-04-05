import type {
  FlowBundledSessionEvent,
  FlowStepRecord,
  LoadedRunBundle,
  SessionRecord,
} from "../types.js";
import type { SelectedAttemptView, SessionListItemView } from "./view-model-types.js";

export function selectAttemptView(
  bundle: LoadedRunBundle,
  selectedStepIndex: number,
): SelectedAttemptView | null {
  const step = bundle.steps[selectedStepIndex];

  if (!step) {
    return null;
  }

  const sessionSourceStep = resolveSessionSourceStep(bundle.steps, selectedStepIndex);
  const sessionId =
    sessionSourceStep?.trace?.conversation?.sessionId ?? sessionSourceStep?.trace?.sessionId;
  const session = sessionId ? (bundle.sessions[sessionId] ?? null) : null;
  const sessionRecord = session?.record ?? null;
  const sessionEvents = session?.events ?? [];
  const conversation = sessionSourceStep?.trace?.conversation;
  const sessionSlice = createSessionSlice(
    sessionRecord,
    conversation?.messageStart,
    conversation?.messageEnd,
  );
  const rawEventSlice = createRawEventSlice(
    sessionEvents,
    conversation?.eventStartSeq,
    conversation?.eventEndSeq,
  );
  const traceEvents = bundle.trace.filter((event) => event.attemptId === step.attemptId);

  return {
    step,
    sessionSourceStep,
    sessionFromFallback:
      sessionSourceStep != null && sessionSourceStep.attemptId !== step.attemptId,
    sessionRecord,
    sessionEvents,
    sessionSlice,
    rawEventSlice,
    traceEvents,
  };
}

export function listSessionViews(
  bundle: LoadedRunBundle,
  selectedAttempt: SelectedAttemptView | null,
): SessionListItemView[] {
  if (!selectedAttempt?.sessionRecord) {
    return [];
  }
  const streamingSessionId =
    selectedAttempt?.sessionSourceStep?.trace?.conversation?.sessionId ??
    selectedAttempt?.sessionSourceStep?.trace?.sessionId ??
    null;
  const conversation = selectedAttempt?.sessionSourceStep?.trace?.conversation;

  return Object.values(bundle.sessions)
    .slice()
    .toSorted((left, right) =>
      (left.record.name ?? left.binding.name ?? left.id).localeCompare(
        right.record.name ?? right.binding.name ?? right.id,
      ),
    )
    .map((session) => ({
      id: session.id,
      label: session.record.name ?? session.binding.name ?? session.id,
      sessionRecord: session.record,
      sessionSlice: createSessionSlice(
        session.record,
        session.id === streamingSessionId ? conversation?.messageStart : undefined,
        session.id === streamingSessionId ? conversation?.messageEnd : undefined,
      ),
      isStreamingSource: session.id === streamingSessionId,
    }));
}

export function revealConversationSlice(
  sessionSlice: SelectedAttemptView["sessionSlice"],
  progress: number,
): SelectedAttemptView["sessionSlice"] {
  const clampedProgress = clamp01(progress);
  if (clampedProgress >= 1) {
    return sessionSlice;
  }
  const revealed: SelectedAttemptView["sessionSlice"] = [];
  const totalWeight = countStreamedConversationChars(sessionSlice);

  if (totalWeight <= 0) {
    return sessionSlice.filter(isRevealableMessage);
  }

  let consumedWeight = 0;

  for (let index = 0; index < sessionSlice.length; index += 1) {
    const message = sessionSlice[index];
    if (!message) {
      break;
    }

    if (!isRevealableMessage(message)) {
      continue;
    }

    const messageWeight = messageRevealWeight(message);
    const start = consumedWeight / totalWeight;

    if (messageWeight <= 0) {
      if (clampedProgress >= start) {
        revealed.push(message);
        continue;
      }
      break;
    }

    const end = (consumedWeight + messageWeight) / totalWeight;
    if (clampedProgress >= end) {
      revealed.push(message);
      consumedWeight += messageWeight;
      continue;
    }

    if (clampedProgress < start) {
      break;
    }

    const charCount = messageWeight;
    const localProgress = clamp01(
      (clampedProgress - start) / Math.max(end - start, Number.EPSILON),
    );
    const revealedParts =
      charCount > 0
        ? revealMessageParts(message.parts, Math.max(1, Math.round(charCount * localProgress)))
        : [];

    if (revealedParts.length > 0 || (message.parts.length === 0 && localProgress >= 1)) {
      revealed.push(buildPartialMessage(message, revealedParts));
    }
    break;
  }

  return revealed;
}

export function revealConversationTranscript(
  sessionSlice: SelectedAttemptView["sessionSlice"],
  progress: number,
): SelectedAttemptView["sessionSlice"] {
  const highlightedIndexes = sessionSlice
    .map((message, index) => (message.highlighted ? index : -1))
    .filter((index) => index >= 0);

  if (highlightedIndexes.length === 0) {
    return sessionSlice;
  }

  const firstHighlightedIndex = highlightedIndexes[0]!;
  const lastHighlightedIndex = highlightedIndexes.at(-1)!;
  const visiblePrefix = sessionSlice.slice(0, firstHighlightedIndex);
  const highlightedSlice = sessionSlice.slice(firstHighlightedIndex, lastHighlightedIndex + 1);
  const visibleHighlightedSlice = revealConversationSlice(highlightedSlice, progress);

  return [...visiblePrefix, ...visibleHighlightedSlice];
}

export function countStreamedConversationChars(
  sessionSlice: SelectedAttemptView["sessionSlice"],
): number {
  return sessionSlice.reduce((sum, message) => sum + messageRevealWeight(message), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function resolveSessionSourceStep(
  steps: FlowStepRecord[],
  selectedStepIndex: number,
): FlowStepRecord | null {
  const direct = steps[selectedStepIndex];
  if (direct?.trace?.conversation) {
    return direct;
  }

  for (let index = selectedStepIndex - 1; index >= 0; index -= 1) {
    const candidate = steps[index];
    if (candidate?.trace?.conversation || candidate?.session) {
      return candidate;
    }
  }

  if (direct?.session) {
    return direct;
  }

  return null;
}

function createSessionSlice(
  sessionRecord: SessionRecord | null,
  start: number | undefined,
  end: number | undefined,
): SelectedAttemptView["sessionSlice"] {
  const messages = Array.isArray(sessionRecord?.messages) ? sessionRecord.messages : [];
  return messages.map((message, index) => {
    const role = detectMessageRole(message);
    const contentView = describeMessage(message, role);
    return {
      index,
      role,
      title: role === "agent" ? "Agent" : role === "user" ? "User" : "Message",
      highlighted:
        typeof start === "number" && typeof end === "number" && index >= start && index <= end,
      textBlocks: contentView.textBlocks,
      toolUses: contentView.toolUses,
      toolResults: contentView.toolResults,
      hiddenPayloads: contentView.hiddenPayloads,
      parts: contentView.parts,
    };
  });
}

function isRevealableMessage(message: SelectedAttemptView["sessionSlice"][number]): boolean {
  return (
    message.textBlocks.length > 0 ||
    message.toolUses.length > 0 ||
    message.toolResults.length > 0 ||
    message.hiddenPayloads.length > 0
  );
}

function messageRevealWeight(message: SelectedAttemptView["sessionSlice"][number]): number {
  if (message.role !== "agent") {
    return 0;
  }
  return message.parts.reduce((sum, part) => sum + partRevealWeight(part), 0);
}

function revealMessageParts(
  parts: SelectedAttemptView["sessionSlice"][number]["parts"],
  budget: number,
): SelectedAttemptView["sessionSlice"][number]["parts"] {
  const revealed: SelectedAttemptView["sessionSlice"][number]["parts"] = [];
  let remaining = Math.max(0, budget);

  for (const part of parts) {
    if (remaining <= 0) {
      break;
    }

    if (part.type === "text") {
      const take = Math.min(part.text.length, remaining);
      if (take > 0) {
        revealed.push({ type: "text", text: part.text.slice(0, take) });
        remaining -= take;
      }
      if (take < part.text.length) {
        break;
      }
      continue;
    }

    const weight = partRevealWeight(part);
    if (remaining < weight) {
      break;
    }
    revealed.push(part);
    remaining -= weight;
  }

  return revealed;
}

function buildPartialMessage(
  message: SelectedAttemptView["sessionSlice"][number],
  parts: SelectedAttemptView["sessionSlice"][number]["parts"],
): SelectedAttemptView["sessionSlice"][number] {
  return {
    ...message,
    textBlocks: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    toolUses: parts.flatMap((part) => (part.type === "tool_use" ? [part.toolUse] : [])),
    toolResults: parts.flatMap((part) => (part.type === "tool_result" ? [part.toolResult] : [])),
    hiddenPayloads: parts.flatMap((part) => (part.type === "hidden_payload" ? [part.payload] : [])),
    parts,
  };
}

function partRevealWeight(
  part: SelectedAttemptView["sessionSlice"][number]["parts"][number],
): number {
  switch (part.type) {
    case "text":
      return Math.max(part.text.length, 1);
    case "tool_use":
      return Math.max(part.toolUse.summary.length, 16);
    case "tool_result":
      return Math.max(part.toolResult.preview.length, 16);
    case "hidden_payload":
      return Math.max(part.payload.label.length, 12);
    default:
      return 1;
  }
}

function createRawEventSlice(
  events: FlowBundledSessionEvent[],
  startSeq: number | undefined,
  endSeq: number | undefined,
): FlowBundledSessionEvent[] {
  if (typeof startSeq !== "number" || typeof endSeq !== "number") {
    return [];
  }
  return events.filter((event) => event.seq >= startSeq && event.seq <= endSeq);
}

function detectMessageRole(message: unknown): "user" | "agent" | "unknown" {
  if (message && typeof message === "object") {
    if ("User" in message) {
      return "user";
    }
    if ("Agent" in message) {
      return "agent";
    }
  }
  return "unknown";
}

function describeMessage(
  message: unknown,
  role: "user" | "agent" | "unknown",
): Pick<
  SelectedAttemptView["sessionSlice"][number],
  "textBlocks" | "toolUses" | "toolResults" | "hiddenPayloads" | "parts"
> {
  if (!message || typeof message !== "object") {
    const text = String(message ?? "");
    return {
      textBlocks: [text].filter(Boolean),
      toolUses: [],
      toolResults: [],
      hiddenPayloads: [],
      parts: text ? [{ type: "text", text }] : [],
    };
  }

  if (role === "user") {
    const user = (message as { User?: { content?: unknown } }).User;
    return describeStructuredMessage(user?.content, undefined);
  }

  if (role === "agent") {
    const agent = (
      message as {
        Agent?: {
          content?: unknown;
          tool_results?: unknown;
        };
      }
    ).Agent;
    return describeStructuredMessage(agent?.content, agent?.tool_results);
  }

  return {
    textBlocks: [],
    toolUses: [],
    toolResults: [],
    hiddenPayloads: [{ label: "Raw message", raw: message }],
    parts: [{ type: "hidden_payload", payload: { label: "Raw message", raw: message } }],
  };
}

function describeStructuredMessage(
  content: unknown,
  toolResults: unknown,
): Pick<
  SelectedAttemptView["sessionSlice"][number],
  "textBlocks" | "toolUses" | "toolResults" | "hiddenPayloads" | "parts"
> {
  const textBlocks: string[] = [];
  const toolUses: SelectedAttemptView["sessionSlice"][number]["toolUses"] = [];
  const hiddenPayloads: SelectedAttemptView["sessionSlice"][number]["hiddenPayloads"] = [];
  const contentParts: SelectedAttemptView["sessionSlice"][number]["parts"] = [];

  if (Array.isArray(content)) {
    for (const [index, part] of content.entries()) {
      if (!part || typeof part !== "object") {
        const text = String(part ?? "").trim();
        if (text) {
          textBlocks.push(text);
          contentParts.push({ type: "text", text });
        }
        continue;
      }

      if ("Text" in part && typeof (part as { Text?: unknown }).Text === "string") {
        const text = (part as { Text: string }).Text.trim();
        if (text) {
          textBlocks.push(text);
          contentParts.push({ type: "text", text });
        }
        continue;
      }

      if ("ToolUse" in part) {
        const toolUse = (part as { ToolUse?: Record<string, unknown> }).ToolUse;
        if (toolUse && typeof toolUse === "object") {
          const toolUseView = {
            id: String(toolUse.id ?? `tool-use-${index}`),
            name: typeof toolUse.name === "string" ? toolUse.name : "Tool call",
            summary: summarizeToolUse(toolUse),
            raw: toolUse,
          };
          toolUses.push(toolUseView);
          contentParts.push({ type: "tool_use", toolUse: toolUseView });
          continue;
        }
      }

      const payload = {
        label: `Structured content ${index + 1}`,
        raw: part,
      };
      hiddenPayloads.push(payload);
      contentParts.push({ type: "hidden_payload", payload });
    }
  } else if (content != null) {
    const payload = {
      label: "Structured content",
      raw: content,
    };
    hiddenPayloads.push(payload);
    contentParts.push({ type: "hidden_payload", payload });
  }

  const resolvedToolResults = describeToolResults(toolResults);
  const orderedParts = buildOrderedMessageParts(contentParts, resolvedToolResults);

  return {
    textBlocks,
    toolUses,
    toolResults: resolvedToolResults,
    hiddenPayloads,
    parts: orderedParts,
  };
}

function describeToolResults(
  toolResults: unknown,
): SelectedAttemptView["sessionSlice"][number]["toolResults"] {
  if (!toolResults || typeof toolResults !== "object") {
    return [];
  }

  return Object.entries(toolResults as Record<string, unknown>).map(([id, entry]) => {
    const result = entry as {
      tool_name?: unknown;
      is_error?: unknown;
      output?: Record<string, unknown>;
      content?: unknown;
    };

    const toolName =
      typeof result.tool_name === "string" && result.tool_name.trim().length > 0
        ? result.tool_name
        : "Tool result";
    const preview = summarizeToolResult(result);
    const status =
      typeof result.output?.status === "string"
        ? result.output.status
        : result.is_error
          ? "error"
          : "completed";

    return {
      id,
      toolName,
      status,
      preview,
      isError: Boolean(result.is_error),
      raw: result,
    };
  });
}

function buildOrderedMessageParts(
  contentParts: SelectedAttemptView["sessionSlice"][number]["parts"],
  toolResults: SelectedAttemptView["sessionSlice"][number]["toolResults"],
): SelectedAttemptView["sessionSlice"][number]["parts"] {
  if (toolResults.length === 0) {
    return contentParts;
  }

  const resultsByToolUseId = new Map<
    string,
    SelectedAttemptView["sessionSlice"][number]["toolResults"]
  >();
  const unmatched: SelectedAttemptView["sessionSlice"][number]["toolResults"] = [];

  for (const toolResult of toolResults) {
    const toolUseId =
      typeof toolResult.raw === "object" &&
      toolResult.raw !== null &&
      "tool_use_id" in toolResult.raw &&
      typeof (toolResult.raw as { tool_use_id?: unknown }).tool_use_id === "string"
        ? (toolResult.raw as { tool_use_id: string }).tool_use_id
        : toolResult.id;

    if (!toolUseId) {
      unmatched.push(toolResult);
      continue;
    }

    const bucket = resultsByToolUseId.get(toolUseId) ?? [];
    bucket.push(toolResult);
    resultsByToolUseId.set(toolUseId, bucket);
  }

  const ordered: SelectedAttemptView["sessionSlice"][number]["parts"] = [];
  for (const part of contentParts) {
    ordered.push(part);
    if (part.type !== "tool_use") {
      continue;
    }
    const matchingResults = resultsByToolUseId.get(part.toolUse.id) ?? [];
    for (const toolResult of matchingResults) {
      ordered.push({ type: "tool_result", toolResult });
    }
    resultsByToolUseId.delete(part.toolUse.id);
  }

  for (const remaining of resultsByToolUseId.values()) {
    unmatched.push(...remaining);
  }

  for (const toolResult of unmatched) {
    ordered.push({ type: "tool_result", toolResult });
  }

  return ordered;
}

function summarizeToolUse(toolUse: Record<string, unknown>): string {
  const parsed =
    parsePossiblyEncodedJson(toolUse.input) ?? parsePossiblyEncodedJson(toolUse.raw_input);
  const parsedCommand = findFirstParsedCommand(parsed);
  if (parsedCommand) {
    return parsedCommand;
  }
  const command = findShellCommand(parsed);
  if (command) {
    return command;
  }
  return "Structured input hidden by default";
}

function summarizeToolResult(result: {
  output?: Record<string, unknown>;
  content?: unknown;
}): string {
  const output = result.output ?? {};
  const preferredText = [
    typeof output.formatted_output === "string" ? output.formatted_output : null,
    typeof output.aggregated_output === "string" ? output.aggregated_output : null,
    typeof output.stderr === "string" && output.stderr.trim().length > 0 ? output.stderr : null,
    typeof output.stdout === "string" && output.stdout.trim().length > 0 ? output.stdout : null,
    extractTextFromToolContent(result.content),
  ].find((value): value is string => Boolean(value && value.trim().length > 0));

  if (!preferredText) {
    return "Structured result hidden by default";
  }

  const normalized = preferredText.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function parsePossiblyEncodedJson(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function findFirstParsedCommand(payload: Record<string, unknown> | null): string | null {
  const parsedCmd = payload?.parsed_cmd;
  if (!Array.isArray(parsedCmd) || parsedCmd.length === 0) {
    return null;
  }
  const first = parsedCmd[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") {
    return null;
  }
  const name = typeof first.name === "string" ? first.name : null;
  const cmd = typeof first.cmd === "string" ? first.cmd : null;
  if (name && cmd) {
    return `${name}: ${truncate(cmd, 96)}`;
  }
  if (cmd) {
    return truncate(cmd, 96);
  }
  return name;
}

function findShellCommand(payload: Record<string, unknown> | null): string | null {
  const command = payload?.command;
  if (!Array.isArray(command) || command.length === 0) {
    return null;
  }
  return truncate(
    command.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "),
    96,
  );
}

function extractTextFromToolContent(content: unknown): string | null {
  if (!content) {
    return null;
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((entry) =>
        entry && typeof entry === "object" && "Text" in entry
          ? (entry as { Text?: unknown }).Text
          : null,
      )
      .filter((entry): entry is string => typeof entry === "string")
      .join("\n");
    return text || null;
  }
  if (typeof content === "object" && "Text" in content) {
    const text = (content as { Text?: unknown }).Text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
