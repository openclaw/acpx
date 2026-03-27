import { formatDuration, humanizeIdentifier, type RunOutcomeView } from "../lib/view-model";
import type { FlowStepRecord } from "../types";

type StepTimelineProps = {
  steps: FlowStepRecord[];
  selectedIndex: number;
  playing: boolean;
  runOutcome: RunOutcomeView;
  onSelect(index: number): void;
  onPlay(): void;
  onPause(): void;
  onReset(): void;
  onJumpToEnd(): void;
};

export function StepTimeline({
  steps,
  selectedIndex,
  playing,
  runOutcome,
  onSelect,
  onPlay,
  onPause,
  onReset,
  onJumpToEnd,
}: StepTimelineProps) {
  if (steps.length === 0) {
    return (
      <section className="timeline">
        <div className="timeline__empty">This run has no step attempts yet.</div>
      </section>
    );
  }

  const currentStep = steps[selectedIndex] ?? steps[0];
  const currentDuration =
    currentStep != null
      ? formatDuration(Date.parse(currentStep.finishedAt) - Date.parse(currentStep.startedAt))
      : "n/a";
  const currentNodeLabel = currentStep ? humanizeIdentifier(currentStep.nodeId) : "n/a";

  return (
    <section className="timeline">
      <div className="timeline__toolbar">
        <div className="timeline__summary">
          <div className="timeline__label">Replay position</div>
          <div className="timeline__headline">{currentNodeLabel}</div>
          <div className="timeline__subheadline">
            Attempt {selectedIndex + 1} of {steps.length} · {currentStep?.nodeType ?? "n/a"} ·{" "}
            {currentStep?.outcome ?? "n/a"} · {currentDuration}
          </div>
        </div>
        <div className="timeline__actions">
          <button type="button" className="ghost-button" onClick={onReset}>
            Start
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onSelect(Math.max(selectedIndex - 1, 0))}
            disabled={selectedIndex === 0}
          >
            Back
          </button>
          <button type="button" className="primary-button" onClick={playing ? onPause : onPlay}>
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onSelect(Math.min(selectedIndex + 1, steps.length - 1))}
            disabled={selectedIndex >= steps.length - 1}
          >
            Next
          </button>
          <button type="button" className="ghost-button" onClick={onJumpToEnd}>
            Latest
          </button>
        </div>
      </div>
      <div className={`timeline__outcome-strip timeline__outcome-strip--${runOutcome.accent}`}>
        <span className={`outcome-pill outcome-pill--${runOutcome.status}`}>
          {runOutcome.shortLabel}
        </span>
        <span>{runOutcome.headline}</span>
        {runOutcome.nodeId ? (
          <span className="timeline__outcome-node">{humanizeIdentifier(runOutcome.nodeId)}</span>
        ) : null}
      </div>
      <div className="timeline__meter">
        <div className="timeline__meter-labels">
          <span>{currentStep?.attemptId ?? `step ${selectedIndex + 1}`}</span>
          <span>{playing ? "playing" : "paused"}</span>
          <span>{steps.length} recorded</span>
        </div>
        <input
          className="timeline__scrubber"
          type="range"
          min={0}
          max={Math.max(steps.length - 1, 0)}
          step={1}
          value={selectedIndex}
          onChange={(event) => onSelect(Number(event.target.value))}
          aria-label={`Replay position step ${selectedIndex + 1} of ${steps.length}`}
        />
      </div>
      <div className="timeline__footer">
        <span>{currentStep?.attemptId ?? "n/a"}</span>
        <span>
          {currentStep?.session?.handle ? `session ${currentStep.session.handle}` : "no session"}
        </span>
      </div>
    </section>
  );
}
