import { useCallback, useState } from "react";
import {
  createDirectoryBundleReader,
  createRecentRunBundleReader,
  createSampleBundleReader,
  listRecentRuns,
} from "../lib/bundle-reader";
import { loadRunBundle } from "../lib/load-bundle";
import { readRequestedRunIdFromWindow, syncRequestedRunId } from "../lib/run-url";
import type { LoadedRunBundle, RunBundleSummary } from "../types";

export type RunBundleLoadingState = "bootstrap" | "runs" | "sample" | "local" | "run" | null;

export function useRunBundleLoader() {
  const [bundle, setBundle] = useState<LoadedRunBundle | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunBundleSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<RunBundleLoadingState>("bootstrap");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshRuns = useCallback(async (): Promise<RunBundleSummary[] | null> => {
    setLoadingState("runs");
    try {
      const runs = await listRecentRuns();
      if (runs) {
        setRecentRuns(runs);
      }
      return runs;
    } finally {
      setLoadingState(null);
    }
  }, []);

  const loadSample = useCallback(async (): Promise<LoadedRunBundle | null> => {
    setLoadingState("sample");
    setErrorMessage(null);

    try {
      const loaded = await loadRunBundle(createSampleBundleReader());
      setBundle(loaded);
      setActiveRunId(null);
      syncRequestedRunId(null);
      return loaded;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoadingState(null);
    }
  }, []);

  const loadLocalBundle = useCallback(async (): Promise<LoadedRunBundle | null> => {
    setLoadingState("local");
    setErrorMessage(null);

    try {
      const reader = await createDirectoryBundleReader();
      const loaded = await loadRunBundle(reader);
      setBundle(loaded);
      setActiveRunId(null);
      syncRequestedRunId(null);
      return loaded;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoadingState(null);
    }
  }, []);

  const loadRecentRun = useCallback(
    async (run: RunBundleSummary): Promise<LoadedRunBundle | null> => {
      setLoadingState("run");
      setErrorMessage(null);

      try {
        const loaded = await loadRunBundle(createRecentRunBundleReader(run));
        setBundle(loaded);
        setActiveRunId(run.runId);
        syncRequestedRunId(run.runId);
        return loaded;
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setLoadingState(null);
      }
    },
    [],
  );

  const bootstrap = useCallback(async (): Promise<void> => {
    setLoadingState("bootstrap");
    setErrorMessage(null);

    const runs = await refreshRuns();
    const requestedRunId = readRequestedRunIdFromWindow();
    if (runs && runs.length > 0) {
      const requestedRun = requestedRunId
        ? (runs.find((candidate) => candidate.runId === requestedRunId) ?? null)
        : null;
      await loadRecentRun(requestedRun ?? runs[0]);
      return;
    }
    await loadSample();
  }, [loadRecentRun, loadSample, refreshRuns]);

  return {
    bundle,
    recentRuns,
    activeRunId,
    loadingState,
    errorMessage,
    bootstrap,
    refreshRuns,
    loadSample,
    loadLocalBundle,
    loadRecentRun,
  };
}
