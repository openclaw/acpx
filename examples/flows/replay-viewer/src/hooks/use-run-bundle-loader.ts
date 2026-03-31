import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDirectoryBundleReader,
  createRecentRunBundleReader,
  createSampleBundleReader,
  listRecentRuns,
} from "../lib/bundle-reader";
import { applyReplayPatch, buildReplayWebSocketUrl } from "../lib/live-sync";
import { loadRunBundle } from "../lib/load-bundle";
import { readRequestedRunIdFromWindow, syncRequestedRunId } from "../lib/run-url";
import type {
  LoadedRunBundle,
  ReplayClientMessage,
  ReplayServerMessage,
  RunBundleSummary,
  ViewerRunLiveState,
  ViewerRunsState,
} from "../types";

const REPLAY_PROTOCOL = "acpx.replay.v1";
const RECONNECT_DELAY_MS = 1_000;

export type RunBundleLoadingState = "bootstrap" | "runs" | "sample" | "local" | "run" | null;

export function useRunBundleLoader() {
  const [bundle, setBundleState] = useState<LoadedRunBundle | null>(null);
  const [recentRuns, setRecentRunsState] = useState<RunBundleSummary[]>([]);
  const [activeRunId, setActiveRunIdState] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<RunBundleLoadingState>("bootstrap");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const bundleRef = useRef<LoadedRunBundle | null>(null);
  const recentRunsStateRef = useRef<ViewerRunsState | null>(null);
  const recentRunsVersionRef = useRef<number>(0);
  const runVersionRef = useRef<number>(0);
  const activeRunIdRef = useRef<string | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveReadyRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const previousSubscribedRunIdRef = useRef<string | null>(null);

  const setBundle = useCallback((next: LoadedRunBundle | null) => {
    bundleRef.current = next;
    setBundleState(next);
  }, []);

  const setRecentRuns = useCallback((next: RunBundleSummary[]) => {
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
      return recentRunsStateRef.current?.runs ?? recentRuns;
    }

    setLoadingState("runs");
    try {
      const runs = await listRecentRuns();
      if (runs) {
        recentRunsStateRef.current = {
          schema: "acpx.viewer-runs.v1",
          runs,
        };
        recentRunsVersionRef.current = Math.max(recentRunsVersionRef.current, 1);
        setRecentRuns(runs);
      }
      return runs;
    } finally {
      setLoadingState(null);
    }
  }, [recentRuns, sendLiveMessage, setRecentRuns]);

  const loadSample = useCallback(async (): Promise<LoadedRunBundle | null> => {
    setLoadingState("sample");
    setErrorMessage(null);

    try {
      const loaded = await loadRunBundle(createSampleBundleReader());
      setBundle(loaded);
      setActiveRunId(null);
      runVersionRef.current = 0;
      syncRequestedRunId(null);
      return loaded;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoadingState(null);
    }
  }, [setActiveRunId, setBundle]);

  const loadLocalBundle = useCallback(async (): Promise<LoadedRunBundle | null> => {
    setLoadingState("local");
    setErrorMessage(null);

    try {
      const reader = await createDirectoryBundleReader();
      const loaded = await loadRunBundle(reader);
      setBundle(loaded);
      setActiveRunId(null);
      runVersionRef.current = 0;
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
  }, [setActiveRunId, setBundle]);

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
    [setActiveRunId, setBundle],
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
            setRecentRuns(message.state.runs);
            return;
          case "runs_patch":
            if (
              recentRunsStateRef.current == null ||
              recentRunsVersionRef.current !== message.fromVersion
            ) {
              sendLiveMessage({ type: "resync_runs" });
              return;
            }
            recentRunsStateRef.current = applyReplayPatch(recentRunsStateRef.current, message.ops);
            recentRunsVersionRef.current = message.toVersion;
            setRecentRuns(recentRunsStateRef.current.runs);
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
            setBundle(applyReplayPatch(bundleRef.current as ViewerRunLiveState, message.ops));
            runVersionRef.current = message.toVersion;
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
    loadSample,
    loadLocalBundle,
    loadRecentRun,
  };
}
