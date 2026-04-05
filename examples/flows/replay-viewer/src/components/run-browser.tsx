import type { RunBundleSummary } from "../types.js";

type RunBrowserProps = {
  runs: RunBundleSummary[];
  activeRunId?: string;
  collapsed: boolean;
  loading: boolean;
  onToggleCollapsed: () => void;
  onLoadRun: (run: RunBundleSummary) => void;
};

export function RunBrowser({
  runs,
  activeRunId,
  collapsed,
  loading,
  onToggleCollapsed,
  onLoadRun,
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
            const displayName = run.runTitle ?? run.flowName;
            return (
              <button
                key={run.runId}
                type="button"
                className={`run-list-item run-list-item--status-${run.status}${active ? " run-list-item--active" : ""}`}
                onClick={() => onLoadRun(run)}
                aria-label={`${displayName} ${run.runId} ${run.status}`}
                title={`${displayName} • ${run.runId}`}
              >
                {collapsed ? (
                  <>
                    <span
                      className={`run-list-item__status-dot run-list-item__status-dot--${run.status}`}
                      aria-hidden="true"
                    />
                    <span className="run-list-item__abbr">{abbreviateRun(displayName)}</span>
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
          <strong>{loading ? "Watching for recent runs…" : "No recent runs yet."}</strong>
          <span>Start a flow and it will appear here automatically.</span>
        </div>
      )}
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
  return `${run.runTitle ?? run.flowName} · ${shortRunToken(run.runId)}`;
}
