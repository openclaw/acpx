import { formatDate, formatDuration } from "../lib/view-model";
import type { FlowStepRecord } from "../types";

type StepTimelineProps = {
  steps: FlowStepRecord[];
  selectedIndex: number;
  playing: boolean;
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

  return (
    <section className="timeline">
      <div className="timeline__toolbar">
        <div>
          <div className="timeline__label">Replay progress</div>
          <div className="timeline__headline">{currentStep?.nodeId ?? "n/a"}</div>
          <div className="timeline__subheadline">
            {currentStep?.attemptId ?? "n/a"} • Step {selectedIndex + 1} of {steps.length} •{" "}
            {currentStep?.kind ?? "n/a"} • {currentStep?.outcome ?? "n/a"}
          </div>
        </div>
        <div className="timeline__actions">
          <button type="button" className="ghost-button" onClick={onReset}>
            Start
          </button>
          <button type="button" className="primary-button" onClick={playing ? onPause : onPlay}>
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" className="ghost-button" onClick={onJumpToEnd}>
            Latest
          </button>
        </div>
      </div>
      <div
        className="timeline__progress"
        aria-label={`Replay progress ${selectedIndex + 1} of ${steps.length}`}
      >
        <div className="timeline__progress-bar" style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="timeline__rail">
        {steps.map((step, index) => {
          const active = index === selectedIndex;
          const completed = index < selectedIndex;
          return (
            <button
              key={step.attemptId}
              type="button"
              className={`timeline__step${active ? " timeline__step--active" : ""}${completed ? " timeline__step--completed" : ""}`}
              onClick={() => onSelect(index)}
            >
              <span className="timeline__step-index">{index + 1}</span>
              <span className="timeline__step-title">{step.nodeId}</span>
              <span className="timeline__step-meta">
                {step.kind} •{" "}
                {formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}
              </span>
              <span className="timeline__step-date">{formatDate(step.startedAt)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
