const RUN_QUERY_PARAM = "run";

export function readRequestedRunId(search: string): string | null {
  const runId = new URLSearchParams(search).get(RUN_QUERY_PARAM)?.trim() ?? "";
  return runId.length > 0 ? runId : null;
}

export function buildRunLocation(currentUrl: string, runId: string | null): string {
  const url = new URL(currentUrl, "http://localhost");
  if (runId) {
    url.searchParams.set(RUN_QUERY_PARAM, runId);
  } else {
    url.searchParams.delete(RUN_QUERY_PARAM);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  return next.length > 0 ? next : "/";
}

export function readRequestedRunIdFromWindow(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return readRequestedRunId(window.location.search);
}

export function syncRequestedRunId(runId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  const nextLocation = buildRunLocation(window.location.href, runId);
  window.history.replaceState(window.history.state, "", nextLocation);
}
