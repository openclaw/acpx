import type { ReactNode } from "react";
import type { FlowStepRecord } from "../types";

type StepTimelineProps = {
  steps: FlowStepRecord[];
  selectedIndex: number;
  playbackValue: number;
  playbackMax: number;
  currentNodeLabel: string;
  currentMeta: string;
  playing: boolean;
  onSelect(index: number): void;
  onPlay(): void;
  onPause(): void;
  onReset(): void;
  onJumpToEnd(): void;
  onSeekStart(): void;
  onSeek(value: number): void;
  onSeekCommit(value: number): void;
};

export function StepTimeline({
  steps,
  selectedIndex,
  playbackValue,
  playbackMax,
  currentNodeLabel,
  currentMeta,
  playing,
  onSelect,
  onPlay,
  onPause,
  onReset,
  onJumpToEnd,
  onSeekStart,
  onSeek,
  onSeekCommit,
}: StepTimelineProps) {
  if (steps.length === 0) {
    return (
      <section className="timeline">
        <div className="timeline__empty">This run has no step attempts yet.</div>
      </section>
    );
  }

  return (
    <section className="timeline">
      <div className="timeline__meter">
        <input
          className="timeline__scrubber"
          type="range"
          min={0}
          max={Math.max(playbackMax, 0)}
          step={1}
          value={Math.min(playbackValue, Math.max(playbackMax, 0))}
          onPointerDown={onSeekStart}
          onChange={(event) => onSeek(Number(event.target.value))}
          onPointerUp={(event) => onSeekCommit(Number((event.target as HTMLInputElement).value))}
          onKeyUp={(event) => onSeekCommit(Number((event.target as HTMLInputElement).value))}
          onBlur={(event) => onSeekCommit(Number((event.target as HTMLInputElement).value))}
          aria-label={`Replay position step ${selectedIndex + 1} of ${steps.length}`}
        />
      </div>
      <div className="timeline__transport">
        <div className="timeline__current">
          <div className="timeline__headline">{currentNodeLabel}</div>
          <div className="timeline__subheadline">{currentMeta}</div>
        </div>
        <div className="timeline__actions">
          <IconButton label="Jump to start" onClick={onReset}>
            <FirstIcon />
          </IconButton>
          <IconButton
            label="Previous step"
            onClick={() => onSelect(Math.max(selectedIndex - 1, 0))}
            disabled={selectedIndex === 0}
          >
            <PreviousIcon />
          </IconButton>
          <IconButton
            label={playing ? "Pause replay" : "Play replay"}
            onClick={playing ? onPause : onPlay}
            primary
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </IconButton>
          <IconButton
            label="Next step"
            onClick={() => onSelect(Math.min(selectedIndex + 1, steps.length - 1))}
            disabled={selectedIndex >= steps.length - 1}
          >
            <NextIcon />
          </IconButton>
          <IconButton label="Jump to latest" onClick={onJumpToEnd}>
            <LastIcon />
          </IconButton>
        </div>
        <div className="timeline__transport-spacer" aria-hidden="true" />
      </div>
    </section>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled = false,
  primary = false,
}: {
  children: ReactNode;
  label: string;
  onClick(): void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`timeline__icon-button${primary ? " timeline__icon-button--primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function FirstIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5v14" />
      <path d="m18 6-8 6 8 6z" />
    </svg>
  );
}

function PreviousIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6v12l10-6z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6v12" />
      <path d="M16 6v12" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function LastIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 8 6-8 6z" />
      <path d="M18 5v14" />
    </svg>
  );
}
