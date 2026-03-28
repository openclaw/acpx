import type { RunBundleSummary } from "../types";

type RunBrowserProps = {
  runs: RunBundleSummary[];
  activeRunId?: string;
  collapsed: boolean;
  loading: boolean;
  directoryPickerSupported: boolean;
  onToggleCollapsed: () => void;
  onRefresh: () => void;
  onLoadSample: () => void;
  onLoadRun: (run: RunBundleSummary) => void;
  onOpenLocal: () => void;
};

export function RunBrowser({
  runs,
  activeRunId,
  collapsed,
  loading,
  directoryPickerSupported,
  onToggleCollapsed,
  onRefresh,
  onLoadSample,
  onLoadRun,
  onOpenLocal,
}: RunBrowserProps) {
  return (
    <aside className={`run-browser${collapsed ? " run-browser--collapsed" : ""}`}>
      <div className="run-browser__header">
        <div className="run-browser__header-copy">
          {!collapsed ? <div className="hero__eyebrow">Recent runs</div> : null}
          {!collapsed ? <h2>Flow runs</h2> : null}
        </div>
        <button
          type="button"
          className="ghost-button run-browser__toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand runs sidebar" : "Collapse runs sidebar"}
        >
          {collapsed ? ">" : "<"}
        </button>
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
                aria-label={`${run.flowName} ${run.runId} ${run.status}`}
                title={`${run.flowName} • ${run.runId}`}
              >
                {collapsed ? (
                  <>
                    <span
                      className={`run-list-item__status-dot run-list-item__status-dot--${run.status}`}
                      aria-hidden="true"
                    />
                    <span className="run-list-item__abbr">{abbreviateRun(run.flowName)}</span>
                  </>
                ) : (
                  <>
                    <div className="run-list-item__line">
                      <span className="run-list-item__label">{compactRunLabel(run)}</span>
                      <span
                        className={`run-list-item__status-dot run-list-item__status-dot--${run.status}`}
                        aria-hidden="true"
                      />
                    </div>
                  </>
                )}
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

      {!collapsed ? (
        <div className="run-browser__footer">
          <button type="button" className="ghost-button" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="ghost-button" onClick={onLoadSample}>
            Sample
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={onOpenLocal}
            disabled={!directoryPickerSupported}
          >
            Open bundle
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function abbreviateRun(flowName: string): string {
  const parts = flowName.split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return flowName.slice(0, 2).toUpperCase();
}

function shortRunToken(runId: string): string {
  const parts = runId.split("-");
  return parts.at(-1) ?? runId;
}

function compactRunLabel(run: RunBundleSummary): string {
  return `${run.flowName} · ${shortRunToken(run.runId)}`;
}
