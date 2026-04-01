import { useCallback, useEffect, useRef, useState } from "react";
import { createRecentRunBundleReader, listRecentRuns } from "../lib/bundle-reader.js";
import { applyReplayPatch, buildReplayWebSocketUrl } from "../lib/live-sync.js";
import { loadRunBundle } from "../lib/load-bundle.js";
import { readRequestedRunIdFromWindow, syncRequestedRunId } from "../lib/run-url.js";
import { buildViewerRunsState, listViewerRuns } from "../lib/runs-state.js";
import type {
  LoadedRunBundle,
  ReplayClientMessage,
  ReplayServerMessage,
  RunBundleSummary,
  ViewerRunLiveState,
  ViewerRunsState,
} from "../types.js";

const REPLAY_PROTOCOL = "acpx.replay.v1";
const RECONNECT_DELAY_MS = 1_000;

export type RunBundleLoadingState = "bootstrap" | "runs" | "run" | null;

export type RunBundleLoaderDeps = {
  createRecentRunBundleReader: typeof createRecentRunBundleReader;
  listRecentRuns: typeof listRecentRuns;
  loadRunBundle: typeof loadRunBundle;
};

const DEFAULT_DEPS: RunBundleLoaderDeps = {
  createRecentRunBundleReader,
  listRecentRuns,
  loadRunBundle,
};

export function useRunBundleLoader(deps: RunBundleLoaderDeps = DEFAULT_DEPS) {
  const [bundle, setBundleState] = useState<LoadedRunBundle | null>(null);
  const [recentRuns, setRecentRunsState] = useState<RunBundleSummary[]>([]);
  const [activeRunId, setActiveRunIdState] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<RunBundleLoadingState>("bootstrap");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const bundleRef = useRef<LoadedRunBundle | null>(null);
  const recentRunsRef = useRef<RunBundleSummary[]>([]);
  const recentRunsStateRef = useRef<ViewerRunsState | null>(null);
  const recentRunsVersionRef = useRef<number>(0);
  const runVersionRef = useRef<number>(0);
  const activeRunIdRef = useRef<string | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveReadyRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const previousSubscribedRunIdRef = useRef<string | null>(null);
  const loadingRunIdRef = useRef<string | null>(null);
  const bootstrapSequenceRef = useRef(0);
  const loadRunSequenceRef = useRef(0);

  const setBundle = useCallback((next: LoadedRunBundle | null) => {
    bundleRef.current = next;
    setBundleState(next);
  }, []);

  const setRecentRuns = useCallback((next: RunBundleSummary[]) => {
    recentRunsRef.current = next;
    setRecentRunsState(next);
  }, []);

  const setActiveRunId = useCallback((next: string | null) => {
    activeRunIdRef.current = next;
    setActiveRunIdState(next);
  }, []);

  const sendLiveMessage = useCallback((message: ReplayClientMessage) => {
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  }, []);

  const refreshRuns = useCallback(async (): Promise<RunBundleSummary[] | null> => {
    if (liveReadyRef.current) {
      sendLiveMessage({ type: "resync_runs" });
      return recentRunsStateRef.current
        ? listViewerRuns(recentRunsStateRef.current)
        : recentRunsRef.current;
    }

    setLoadingState("runs");
    try {
      const runs = await deps.listRecentRuns();
      if (runs) {
        recentRunsStateRef.current = buildViewerRunsState(runs);
        recentRunsVersionRef.current = Math.max(recentRunsVersionRef.current, 1);
        setRecentRuns(runs);
      }
      return runs;
    } finally {
      setLoadingState(null);
    }
  }, [deps, sendLiveMessage, setRecentRuns]);

  const resolvePreferredRecentRun = useCallback(
    (runs: RunBundleSummary[]): RunBundleSummary | null => {
      const requestedRunId = readRequestedRunIdFromWindow();
      if (requestedRunId) {
        const requestedRun = runs.find((candidate) => candidate.runId === requestedRunId) ?? null;
        if (requestedRun) {
          return requestedRun;
        }
      }
      return runs[0] ?? null;
    },
    [],
  );

  const loadRecentRun = useCallback(
    async (run: RunBundleSummary): Promise<LoadedRunBundle | null> => {
      if (activeRunIdRef.current === run.runId && bundleRef.current?.sourceType === "recent") {
        return bundleRef.current;
      }
      if (loadingRunIdRef.current === run.runId) {
        return null;
      }

      const loadSequence = ++loadRunSequenceRef.current;
      setLoadingState("run");
      setErrorMessage(null);
      loadingRunIdRef.current = run.runId;

      try {
        const loaded = await deps.loadRunBundle(deps.createRecentRunBundleReader(run));
        if (loadRunSequenceRef.current !== loadSequence) {
          return null;
        }
        setBundle(loaded);
        setActiveRunId(run.runId);
        syncRequestedRunId(run.runId);
        return loaded;
      } catch (error) {
        if (loadRunSequenceRef.current === loadSequence) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
        return null;
      } finally {
        if (loadRunSequenceRef.current === loadSequence && loadingRunIdRef.current === run.runId) {
          loadingRunIdRef.current = null;
          setLoadingState(null);
        }
      }
    },
    [deps, setActiveRunId, setBundle],
  );

  const bootstrap = useCallback(async (): Promise<void> => {
    const bootstrapSequence = ++bootstrapSequenceRef.current;
    const bootstrapRecentRunsVersion = recentRunsVersionRef.current;
    const bootstrapRunVersion = runVersionRef.current;
    const bootstrapActiveRunId = activeRunIdRef.current;
    const bootstrapBundle = bundleRef.current;
    const bootstrapRecentRuns = recentRunsRef.current;

    setLoadingState("bootstrap");
    setErrorMessage(null);

    try {
      const runs = (await deps.listRecentRuns()) ?? [];
      if (
        bootstrapSequenceRef.current !== bootstrapSequence ||
        recentRunsVersionRef.current !== bootstrapRecentRunsVersion ||
        runVersionRef.current !== bootstrapRunVersion ||
        activeRunIdRef.current !== bootstrapActiveRunId ||
        bundleRef.current !== bootstrapBundle ||
        recentRunsRef.current !== bootstrapRecentRuns
      ) {
        return;
      }
      recentRunsStateRef.current = buildViewerRunsState(runs);
      recentRunsVersionRef.current = Math.max(recentRunsVersionRef.current, 1);
      setRecentRuns(runs);

      const preferredRun = resolvePreferredRecentRun(runs);
      if (preferredRun) {
        await loadRecentRun(preferredRun);
        return;
      }

      setBundle(null);
      setActiveRunId(null);
      runVersionRef.current = 0;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingState(null);
    }
  }, [deps, loadRecentRun, resolvePreferredRecentRun, setActiveRunId, setBundle, setRecentRuns]);

  useEffect(() => {
    if (recentRuns.length === 0) {
      return;
    }

    const activeRecentRunStillPresent =
      activeRunIdRef.current != null &&
      bundleRef.current?.sourceType === "recent" &&
      recentRuns.some((candidate) => candidate.runId === activeRunIdRef.current);
    if (activeRecentRunStillPresent) {
      return;
    }

    const preferredRun = resolvePreferredRecentRun(recentRuns);
    if (!preferredRun || loadingRunIdRef.current === preferredRun.runId) {
      return;
    }

    void loadRecentRun(preferredRun);
  }, [loadRecentRun, recentRuns, resolvePreferredRecentRun]);

  useEffect(() => {
    const currentRunId = activeRunIdRef.current;
    const currentSourceType = bundleRef.current?.sourceType ?? null;
    const previousRunId = previousSubscribedRunIdRef.current;

    if (previousRunId && previousRunId !== currentRunId) {
      sendLiveMessage({
        type: "unsubscribe_run",
        runId: previousRunId,
      });
      previousSubscribedRunIdRef.current = null;
      runVersionRef.current = 0;
    }

    if (currentRunId && currentSourceType === "recent") {
      if (previousRunId !== currentRunId) {
        sendLiveMessage({
          type: "subscribe_run",
          runId: currentRunId,
        });
        previousSubscribedRunIdRef.current = currentRunId;
      }
      return;
    }

    if (previousRunId) {
      sendLiveMessage({
        type: "unsubscribe_run",
        runId: previousRunId,
      });
      previousSubscribedRunIdRef.current = null;
      runVersionRef.current = 0;
    }
  }, [activeRunId, bundle?.sourceType, sendLiveMessage]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }

      const socket = new WebSocket(buildReplayWebSocketUrl());
      liveSocketRef.current = socket;
      liveReadyRef.current = false;

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "hello",
            protocol: REPLAY_PROTOCOL,
          } satisfies ReplayClientMessage),
        );
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ReplayServerMessage;

        switch (message.type) {
          case "ready":
            liveReadyRef.current = true;
            sendLiveMessage({ type: "subscribe_runs" });
            if (activeRunIdRef.current && bundleRef.current?.sourceType === "recent") {
              sendLiveMessage({
                type: "subscribe_run",
                runId: activeRunIdRef.current,
              });
              previousSubscribedRunIdRef.current = activeRunIdRef.current;
            }
            return;
          case "pong":
            return;
          case "runs_snapshot":
            recentRunsStateRef.current = message.state;
            recentRunsVersionRef.current = message.version;
            setRecentRuns(listViewerRuns(message.state));
            return;
          case "runs_patch":
            if (
              recentRunsStateRef.current == null ||
              recentRunsVersionRef.current !== message.fromVersion
            ) {
              sendLiveMessage({ type: "resync_runs" });
              return;
            }
            try {
              recentRunsStateRef.current = applyReplayPatch(
                recentRunsStateRef.current,
                message.ops,
              );
              recentRunsVersionRef.current = message.toVersion;
              setRecentRuns(listViewerRuns(recentRunsStateRef.current));
            } catch {
              sendLiveMessage({ type: "resync_runs" });
            }
            return;
          case "run_snapshot":
            if (
              activeRunIdRef.current !== message.runId ||
              bundleRef.current?.sourceType !== "recent"
            ) {
              return;
            }
            setBundle(message.state);
            runVersionRef.current = message.version;
            return;
          case "run_patch":
            if (
              activeRunIdRef.current !== message.runId ||
              bundleRef.current?.sourceType !== "recent"
            ) {
              return;
            }
            if (bundleRef.current == null || runVersionRef.current !== message.fromVersion) {
              sendLiveMessage({
                type: "resync_run",
                runId: message.runId,
              });
              return;
            }
            try {
              setBundle(applyReplayPatch(bundleRef.current as ViewerRunLiveState, message.ops));
              runVersionRef.current = message.toVersion;
            } catch {
              sendLiveMessage({
                type: "resync_run",
                runId: message.runId,
              });
            }
            return;
          case "error":
            if (!message.runId || message.runId === activeRunIdRef.current) {
              setErrorMessage(message.message);
            }
            return;
        }
      });

      socket.addEventListener("close", () => {
        if (liveSocketRef.current === socket) {
          liveSocketRef.current = null;
        }
        liveReadyRef.current = false;
        if (!disposed) {
          reconnectTimerRef.current = window.setTimeout(connect, RECONNECT_DELAY_MS);
        }
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      liveReadyRef.current = false;
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      liveSocketRef.current?.close();
      liveSocketRef.current = null;
    };
  }, [sendLiveMessage, setBundle, setRecentRuns]);

  return {
    bundle,
    recentRuns,
    activeRunId,
    loadingState,
    errorMessage,
    bootstrap,
    refreshRuns,
    loadRecentRun,
  };
}
