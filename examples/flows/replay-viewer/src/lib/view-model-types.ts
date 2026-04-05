import type {
  FlowBundledSessionEvent,
  FlowRunState,
  FlowStepRecord,
  FlowTraceEvent,
  SessionRecord,
} from "../types.js";

export type ViewerNodeStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ViewerNodeData = {
  nodeId: string;
  title: string;
  subtitle: string;
  nodeType: FlowStepRecord["nodeType"];
  status: ViewerNodeStatus;
  attempts: number;
  latestAttemptId?: string;
  durationLabel?: string;
  isStart: boolean;
  isTerminal: boolean;
  isDecision: boolean;
  branchCount: number;
  branchLabels: string[];
  isRunOutcomeNode: boolean;
  runOutcomeLabel?: string;
  runOutcomeAccent?: RunOutcomeView["accent"];
  playbackProgress?: number;
};

export type ViewerPoint = {
  x: number;
  y: number;
};

export type ViewerEdgeData = {
  points?: ViewerPoint[];
  isBackEdge: boolean;
};

export type ViewerGraphLayout = {
  nodePositions: Record<string, ViewerPoint>;
  edgeRoutes: Record<
    string,
    {
      points: ViewerPoint[];
      isBackEdge: boolean;
    }
  >;
};

export type PlaybackSegment = {
  stepIndex: number;
  nodeId: string;
  nodeType: FlowStepRecord["nodeType"];
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type PlaybackTimeline = {
  segments: PlaybackSegment[];
  totalDurationMs: number;
};

export type PlaybackPreview = {
  playheadMs: number;
  activeStepIndex: number;
  nearestStepIndex: number;
  stepProgress: number;
  stepStartMs: number;
  stepEndMs: number;
  totalDurationMs: number;
};

export type ConversationToolUseView = {
  id: string;
  name: string;
  summary: string;
  raw: unknown;
};

export type ConversationToolResultView = {
  id: string;
  toolName: string;
  status: string;
  preview: string;
  isError: boolean;
  raw: unknown;
};

export type ConversationHiddenPayloadView = {
  label: string;
  raw: unknown;
};

export type ConversationMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_use";
      toolUse: ConversationToolUseView;
    }
  | {
      type: "tool_result";
      toolResult: ConversationToolResultView;
    }
  | {
      type: "hidden_payload";
      payload: ConversationHiddenPayloadView;
    };

export type SelectedAttemptView = {
  step: FlowStepRecord;
  sessionSourceStep: FlowStepRecord | null;
  sessionFromFallback: boolean;
  sessionRecord: SessionRecord | null;
  sessionEvents: FlowBundledSessionEvent[];
  sessionSlice: Array<{
    index: number;
    role: "user" | "agent" | "unknown";
    title: string;
    highlighted: boolean;
    textBlocks: string[];
    toolUses: ConversationToolUseView[];
    toolResults: ConversationToolResultView[];
    hiddenPayloads: ConversationHiddenPayloadView[];
    parts: ConversationMessagePart[];
  }>;
  rawEventSlice: FlowBundledSessionEvent[];
  traceEvents: FlowTraceEvent[];
};

export type SessionListItemView = {
  id: string;
  label: string;
  sessionRecord: SessionRecord;
  sessionSlice: SelectedAttemptView["sessionSlice"];
  isStreamingSource: boolean;
};

export type RunOutcomeView = {
  status: FlowRunState["status"];
  headline: string;
  detail: string;
  shortLabel: string;
  accent: "ok" | "active" | "failed" | "timed_out";
  nodeId: string | null;
  attemptId: string | null;
  isTerminal: boolean;
};
