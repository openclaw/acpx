import type { LoadedRunBundle } from "../types.js";
import { countStreamedConversationChars, selectAttemptView } from "./view-model-conversation.js";
import type { PlaybackPreview, PlaybackSegment, PlaybackTimeline } from "./view-model-types.js";

export function buildPlaybackTimeline(bundle: LoadedRunBundle): PlaybackTimeline {
  let cursorMs = 0;

  const segments = bundle.steps.map((step, stepIndex) => {
    const durationMs = estimatePlaybackDuration(bundle, stepIndex);
    const segment = {
      stepIndex,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
      durationMs,
    } satisfies PlaybackSegment;
    cursorMs += durationMs;
    return segment;
  });

  return {
    segments,
    totalDurationMs: Math.max(cursorMs, 0),
  };
}

export function derivePlaybackPreview(
  timeline: PlaybackTimeline,
  playheadMs: number,
): PlaybackPreview | null {
  if (timeline.segments.length === 0) {
    return null;
  }

  const clampedPlayhead = clamp(playheadMs, 0, timeline.totalDurationMs);
  const lastSegment = timeline.segments.at(-1)!;
  const activeSegment =
    timeline.segments.find((segment) => clampedPlayhead < segment.endMs) ?? lastSegment;
  const durationMs = Math.max(activeSegment.durationMs, 1);
  const localProgress =
    activeSegment === lastSegment && clampedPlayhead >= timeline.totalDurationMs
      ? 1
      : clamp01((clampedPlayhead - activeSegment.startMs) / durationMs);

  return {
    playheadMs: clampedPlayhead,
    activeStepIndex: activeSegment.stepIndex,
    nearestStepIndex: findNearestStepIndex(timeline, clampedPlayhead),
    stepProgress: localProgress,
    stepStartMs: activeSegment.startMs,
    stepEndMs: activeSegment.endMs,
    totalDurationMs: timeline.totalDurationMs,
  };
}

export function playbackAnchorMs(timeline: PlaybackTimeline, stepIndex: number): number {
  const segment = timeline.segments[clamp(stepIndex, 0, Math.max(timeline.segments.length - 1, 0))];
  return segment?.startMs ?? 0;
}

export function playbackSelectionMs(
  timeline: PlaybackTimeline,
  stepIndex: number,
  stepCount: number,
): number {
  const isTerminalSelection =
    stepIndex >= Math.max(stepCount - 1, 0) && timeline.segments.length > 0;
  if (isTerminalSelection) {
    return timeline.totalDurationMs;
  }
  return playbackAnchorMs(timeline, stepIndex);
}

function estimatePlaybackDuration(bundle: LoadedRunBundle, stepIndex: number): number {
  const step = bundle.steps[stepIndex];
  if (!step) {
    return 800;
  }

  const actualDurationMs = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt));
  const actualScaledMs = actualDurationMs > 0 ? Math.round(actualDurationMs / 8) : 0;

  if (step.nodeType === "acp") {
    const selected = selectAttemptView(bundle, stepIndex);
    const isDirectSession = selected?.sessionSourceStep?.attemptId === step.attemptId;
    const visibleChars = isDirectSession
      ? countStreamedConversationChars(selected.sessionSlice)
      : [step.promptText, step.rawText].reduce(
          (sum, value) => sum + (typeof value === "string" ? value.length : 0),
          0,
        );
    const revealDurationMs = 420 + visibleChars * 3;
    return clamp(Math.max(actualScaledMs, revealDurationMs), 700, 3_800);
  }

  const minimumMs = step.nodeType === "action" ? 850 : step.nodeType === "checkpoint" ? 650 : 700;
  const maximumMs = step.nodeType === "action" ? 3_000 : 2_400;
  return clamp(Math.max(actualScaledMs, minimumMs), minimumMs, maximumMs);
}

function findNearestStepIndex(timeline: PlaybackTimeline, playheadMs: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of timeline.segments) {
    const distance = Math.abs(segment.startMs - playheadMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = segment.stepIndex;
    }
  }

  return bestIndex;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
