import type {
  FlowBundledSessionEvent,
  FlowRunState,
  FlowStepRecord,
  FlowTraceEvent,
  SessionRecord,
} from "../types";

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
    toolUses: Array<{
      id: string;
      name: string;
      summary: string;
      raw: unknown;
    }>;
    toolResults: Array<{
      id: string;
      toolName: string;
      status: string;
      preview: string;
      isError: boolean;
      raw: unknown;
    }>;
    hiddenPayloads: Array<{
      label: string;
      raw: unknown;
    }>;
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
