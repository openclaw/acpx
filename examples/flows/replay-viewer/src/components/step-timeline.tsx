import { formatDate, formatDuration } from "../lib/view-model";
import type { FlowStepRecord } from "../types";

type StepTimelineProps = {
  steps: FlowStepRecord[];
  selectedIndex: number;
  playing: boolean;
  runStartedAt: string;
  runDurationLabel: string;
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
  runStartedAt,
  runDurationLabel,
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
  const progressPercent = ((selectedIndex + 1) / steps.length) * 100;
  const currentDuration =
    currentStep != null
      ? formatDuration(Date.parse(currentStep.finishedAt) - Date.parse(currentStep.startedAt))
      : "n/a";

  return (
    <section className="timeline">
      <div className="timeline__toolbar">
        <div className="timeline__hero">
          <div className="timeline__label">Replay progress</div>
          <div className="timeline__headline">{currentStep?.nodeId ?? "n/a"}</div>
          <div className="timeline__subheadline">
            Step {selectedIndex + 1} of {steps.length} • {currentStep?.nodeType ?? "n/a"} •{" "}
            {currentStep?.outcome ?? "n/a"} • {currentDuration}
          </div>
          <div className="timeline__stats">
            <span className="timeline__stat">
              <span className="timeline__stat-label">Attempt</span>
              <span>{currentStep?.attemptId ?? "n/a"}</span>
            </span>
            <span className="timeline__stat">
              <span className="timeline__stat-label">Started</span>
              <span>{formatDate(runStartedAt)}</span>
            </span>
            <span className="timeline__stat">
              <span className="timeline__stat-label">Run</span>
              <span>{runDurationLabel}</span>
            </span>
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
      <div className="timeline__meter">
        <div className="timeline__meter-labels">
          <span>{steps[0]?.nodeId ?? "start"}</span>
          <span>{progressPercent.toFixed(0)}%</span>
          <span>{steps.at(-1)?.nodeId ?? "latest"}</span>
        </div>
        <div className="timeline__progress" aria-hidden="true">
          <div className="timeline__progress-bar" style={{ width: `${progressPercent}%` }} />
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
      <div className="timeline__current">
        <div className="timeline__current-main">
          <span className="timeline__current-node">{currentStep?.nodeId ?? "n/a"}</span>
          <span className="timeline__current-attempt">{currentStep?.attemptId ?? "n/a"}</span>
        </div>
        <div className="timeline__current-meta">
          <span>{formatDate(currentStep?.startedAt)}</span>
          <span>
            {currentStep?.session?.handle ? `session ${currentStep.session.handle}` : "no session"}
          </span>
        </div>
      </div>
      <div className="timeline__stops" aria-label="Replay step stops">
        {steps.map((step, index) => {
          const active = index === selectedIndex;
          const completed = index < selectedIndex;
          return (
            <button
              key={step.attemptId}
              type="button"
              className={`timeline__stop${active ? " timeline__stop--active" : ""}${completed ? " timeline__stop--completed" : ""}`}
              onClick={() => onSelect(index)}
              aria-label={`Jump to step ${index + 1}: ${step.nodeId}`}
            >
              <span className="timeline__stop-dot" />
              <span className="timeline__stop-label">{step.nodeId}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
