const RUN_QUERY_PARAM = "run";
const RUN_PATH_PREFIX = "/run/";

export function readRequestedRunId(search: string, pathname: string = "/"): string | null {
  const pathRunId = readRequestedRunIdFromPath(pathname);
  if (pathRunId) {
    return pathRunId;
  }

  const queryRunId = new URLSearchParams(search).get(RUN_QUERY_PARAM)?.trim() ?? "";
  return queryRunId.length > 0 ? queryRunId : null;
}

export function buildRunLocation(currentUrl: string, runId: string | null): string {
  const url = new URL(currentUrl, "http://localhost");
  url.pathname = runId ? `${RUN_PATH_PREFIX}${encodeURIComponent(runId)}` : "/";
  url.searchParams.delete(RUN_QUERY_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  return next.length > 0 ? next : "/";
}

export function readRequestedRunIdFromWindow(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return readRequestedRunId(window.location.search, window.location.pathname);
}

export function syncRequestedRunId(runId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  const nextLocation = buildRunLocation(window.location.href, runId);
  window.history.replaceState(window.history.state, "", nextLocation);
}

function readRequestedRunIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(RUN_PATH_PREFIX)) {
    return null;
  }

  const rawRunId = pathname.slice(RUN_PATH_PREFIX.length).split("/").filter(Boolean)[0] ?? "";
  const runId = decodeURIComponent(rawRunId).trim();
  return runId.length > 0 ? runId : null;
}
