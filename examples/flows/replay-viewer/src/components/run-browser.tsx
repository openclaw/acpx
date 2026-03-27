import { formatDate } from "../lib/view-model";
import type { RunBundleSummary } from "../types";

type RunBrowserProps = {
  runs: RunBundleSummary[];
  activeRunId?: string;
  loading: boolean;
  directoryPickerSupported: boolean;
  onRefresh: () => void;
  onLoadSample: () => void;
  onLoadRun: (run: RunBundleSummary) => void;
  onOpenLocal: () => void;
};

export function RunBrowser({
  runs,
  activeRunId,
  loading,
  directoryPickerSupported,
  onRefresh,
  onLoadSample,
  onLoadRun,
  onOpenLocal,
}: RunBrowserProps) {
  return (
    <section className="run-browser">
      <div className="run-browser__header">
        <div>
          <div className="hero__eyebrow">Recent runs</div>
          <h2>Choose a saved flow run</h2>
          <p>The local viewer server reads `~/.acpx/flows/runs/` and lists recent bundles here.</p>
        </div>
        <div className="run-browser__actions">
          <button type="button" className="primary-button" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh runs"}
          </button>
          <button type="button" className="ghost-button" onClick={onLoadSample}>
            Load bundled sample
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={onOpenLocal}
            disabled={!directoryPickerSupported}
          >
            Open local run bundle
          </button>
        </div>
      </div>

      {runs.length > 0 ? (
        <div className="run-browser__list">
          {runs.map((run) => {
            const active = run.runId === activeRunId;
            return (
              <button
                key={run.runId}
                type="button"
                className={`run-list-item${active ? " run-list-item--active" : ""}`}
                onClick={() => onLoadRun(run)}
              >
                <div className="run-list-item__topline">
                  <span className="run-list-item__flow">{run.flowName}</span>
                  <span className={`run-list-item__status run-list-item__status--${run.status}`}>
                    {run.status}
                  </span>
                </div>
                <div className="run-list-item__runid">{run.runId}</div>
                <div className="run-list-item__meta">
                  <span>{formatDate(run.startedAt)}</span>
                  {run.currentNode ? <span>Current node: {run.currentNode}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="run-browser__empty">
          <strong>No recent run bundles found.</strong>
          <span>Run a flow first, or fall back to the bundled sample.</span>
        </div>
      )}
    </section>
  );
}
