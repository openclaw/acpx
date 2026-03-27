import { useEffect, useMemo, useState } from "react";
import {
  buildPlaybackTimeline,
  derivePlaybackPreview,
  playbackSelectionMs,
} from "../lib/view-model.js";
import type { PlaybackTimeline } from "../lib/view-model.js";
import type { LoadedRunBundle } from "../types";

type PlaybackMode = "playing" | "seeking" | null;

export function usePlaybackController(bundle: LoadedRunBundle | null) {
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  useEffect(() => {
    setSelectedStepIndex(defaultSelectedStepIndex(bundle));
    setPlaybackMode(null);
    setPlayheadMs(null);
  }, [bundle?.run.runId]);

  const playbackTimeline = useMemo(() => (bundle ? buildPlaybackTimeline(bundle) : null), [bundle]);
  const playbackPreview = useMemo(
    () =>
      playbackTimeline && playheadMs != null
        ? derivePlaybackPreview(playbackTimeline, playheadMs)
        : null,
    [playbackTimeline, playheadMs],
  );

  useEffect(() => {
    if (playbackMode !== "playing" || !playbackTimeline || playheadMs == null) {
      return undefined;
    }
    if (playbackTimeline.segments.length === 0) {
      return undefined;
    }
    let frameId = 0;
    let lastTimestamp: number | null = null;

    const tick = (timestamp: number) => {
      if (lastTimestamp == null) {
        lastTimestamp = timestamp;
      }
      const deltaMs = timestamp - lastTimestamp;
      lastTimestamp = timestamp;

      setPlayheadMs((current) => {
        if (current == null) {
          return current;
        }
        return Math.min(current + deltaMs, playbackTimeline.totalDurationMs);
      });
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [playbackMode, playbackTimeline, playheadMs]);

  useEffect(() => {
    if (
      playbackMode === "playing" &&
      playbackTimeline &&
      playbackPreview &&
      playbackPreview.playheadMs >= playbackTimeline.totalDurationMs
    ) {
      setSelectedStepIndex(Math.max(bundle?.steps.length ?? 1, 1) - 1);
      setPlaybackMode(null);
      setPlayheadMs(null);
    }
  }, [bundle?.steps.length, playbackMode, playbackPreview, playbackTimeline]);

  const effectiveStepIndex = playbackPreview?.activeStepIndex ?? selectedStepIndex;

  function clearPlayback(): void {
    setPlaybackMode(null);
    setPlayheadMs(null);
  }

  function selectStep(index: number): void {
    clearPlayback();
    setSelectedStepIndex(index);
  }

  function play(): void {
    if (!playbackTimeline) {
      return;
    }
    const resumeMs = resolvePlaybackResumeMs(
      playbackTimeline,
      playheadMs,
      selectedStepIndex,
      bundle?.steps.length ?? 0,
    );
    setPlayheadMs(resumeMs);
    setPlaybackMode("playing");
  }

  function pause(): void {
    if (!playbackPreview) {
      clearPlayback();
      return;
    }
    setSelectedStepIndex(playbackPreview.nearestStepIndex);
    clearPlayback();
  }

  function reset(): void {
    clearPlayback();
    setSelectedStepIndex(0);
  }

  function jumpToEnd(): void {
    clearPlayback();
    setSelectedStepIndex(Math.max((bundle?.steps.length ?? 1) - 1, 0));
  }

  function startSeek(): void {
    setPlaybackMode("seeking");
    setPlayheadMs(
      playbackPreview?.playheadMs ??
        (playbackTimeline
          ? playbackSelectionMs(playbackTimeline, selectedStepIndex, bundle?.steps.length ?? 0)
          : 0),
    );
  }

  function seek(value: number): void {
    setPlayheadMs(value);
  }

  function commitSeek(value: number): void {
    if (!playbackTimeline) {
      return;
    }
    const preview = derivePlaybackPreview(playbackTimeline, value);
    setSelectedStepIndex(preview?.nearestStepIndex ?? selectedStepIndex);
    clearPlayback();
  }

  return {
    selectedStepIndex,
    effectiveStepIndex,
    playbackMode,
    playbackTimeline,
    playbackPreview,
    isPlaying: playbackMode === "playing",
    clearPlayback,
    selectStep,
    play,
    pause,
    reset,
    jumpToEnd,
    startSeek,
    seek,
    commitSeek,
  };
}

export function resolvePlaybackResumeMs(
  timeline: PlaybackTimeline,
  playheadMs: number | null,
  selectedStepIndex: number,
  stepCount: number,
): number {
  if (playheadMs != null) {
    return playheadMs;
  }
  const isTerminalSelection =
    selectedStepIndex >= Math.max(stepCount - 1, 0) && timeline.segments.length > 0;
  if (isTerminalSelection) {
    return 0;
  }
  return playbackSelectionMs(timeline, selectedStepIndex, stepCount);
}

function defaultSelectedStepIndex(bundle: LoadedRunBundle | null): number {
  return bundle ? Math.max(bundle.steps.length - 1, 0) : 0;
}
