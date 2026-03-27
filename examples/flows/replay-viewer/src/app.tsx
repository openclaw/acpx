import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { FlowNodeCard } from "./components/flow-node-card";
import { InspectorPanel } from "./components/inspector-panel";
import { RunBrowser } from "./components/run-browser";
import { StepTimeline } from "./components/step-timeline";
import {
  createRecentRunBundleReader,
  createDirectoryBundleReader,
  createSampleBundleReader,
  isDirectoryPickerSupported,
  listRecentRuns,
} from "./lib/bundle-reader";
import { loadRunBundle } from "./lib/load-bundle";
import {
  buildGraph,
  buildPlaybackTimeline,
  derivePlaybackPreview,
  formatDuration,
  humanizeIdentifier,
  playbackAnchorMs,
  selectAttemptView,
} from "./lib/view-model";
import type { LoadedRunBundle, RunBundleSummary } from "./types";

const nodeTypes = {
  flowNode: FlowNodeCard,
};

export function App() {
  const [bundle, setBundle] = useState<LoadedRunBundle | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunBundleSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<"attempt" | "session" | "events">("session");
  const [runsCollapsed, setRunsCollapsed] = useState(true);
  const [loadingState, setLoadingState] = useState<
    "bootstrap" | "runs" | "sample" | "local" | "run" | null
  >("bootstrap");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<"playing" | "seeking" | null>(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  const playbackTimeline = useMemo(() => (bundle ? buildPlaybackTimeline(bundle) : null), [bundle]);
  const playbackPreview = useMemo(
    () =>
      playbackTimeline && playheadMs != null
        ? derivePlaybackPreview(playbackTimeline, playheadMs)
        : null,
    [playbackTimeline, playheadMs],
  );

  useEffect(() => {
    if (playbackMode !== "playing" || !playbackTimeline || playheadMs == null) {
      return undefined;
    }
    if (playbackTimeline.segments.length === 0) {
      return undefined;
    }
    let frameId = 0;
    let lastTimestamp: number | null = null;

    const tick = (timestamp: number) => {
      if (lastTimestamp == null) {
        lastTimestamp = timestamp;
      }
      const deltaMs = timestamp - lastTimestamp;
      lastTimestamp = timestamp;

      setPlayheadMs((current) => {
        if (current == null) {
          return current;
        }
        return Math.min(current + deltaMs, playbackTimeline.totalDurationMs);
      });
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [playbackMode, playbackTimeline, playheadMs]);

  useEffect(() => {
    if (
      playbackMode === "playing" &&
      playbackTimeline &&
      playbackPreview &&
      playbackPreview.playheadMs >= playbackTimeline.totalDurationMs
    ) {
      setSelectedStepIndex(Math.max(bundle?.steps.length ?? 1, 1) - 1);
      setPlaybackMode(null);
      setPlayheadMs(null);
    }
  }, [bundle?.steps.length, playbackMode, playbackPreview, playbackTimeline]);

  const effectiveStepIndex = playbackPreview?.activeStepIndex ?? selectedStepIndex;
  const graph = bundle
    ? buildGraph(bundle, effectiveStepIndex, playbackPreview)
    : { nodes: [], edges: [] };
  const selectedAttempt = bundle ? selectAttemptView(bundle, effectiveStepIndex) : null;
  const currentStep = bundle?.steps[effectiveStepIndex] ?? null;
  const currentDuration = currentStep
    ? `${effectiveStepIndex + 1} / ${bundle?.steps.length ?? 0} · ${currentStep.nodeType} · ${playbackPreview ? playbackProgressLabel(playbackPreview.stepProgress) : deriveStepDurationLabel(currentStep)}`
    : "n/a";
  const sessionRevealProgress =
    playbackPreview && selectedAttempt?.step.attemptId === currentStep?.attemptId
      ? playbackPreview.stepProgress
      : null;

  async function bootstrap(): Promise<void> {
    setLoadingState("bootstrap");
    setErrorMessage(null);
    setPlaybackMode(null);
    setPlayheadMs(null);

    const runs = await refreshRuns();
    if (runs && runs.length > 0) {
      await loadRecentRun(runs[0]);
      return;
    }
    await loadSample();
  }

  async function refreshRuns(): Promise<RunBundleSummary[] | null> {
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
  }

  async function loadSample(): Promise<void> {
    setLoadingState("sample");
    setErrorMessage(null);
    setPlaybackMode(null);
    setPlayheadMs(null);

    try {
      const loaded = await loadRunBundle(createSampleBundleReader());
      setBundle(loaded);
      setActiveRunId(null);
      setSelectedStepIndex(defaultSelectedStepIndex(loaded));
      setActiveTab("session");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingState(null);
    }
  }

  async function loadLocalBundle(): Promise<void> {
    setLoadingState("local");
    setErrorMessage(null);
    setPlaybackMode(null);
    setPlayheadMs(null);

    try {
      const reader = await createDirectoryBundleReader();
      const loaded = await loadRunBundle(reader);
      setBundle(loaded);
      setActiveRunId(null);
      setSelectedStepIndex(defaultSelectedStepIndex(loaded));
      setActiveTab("session");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingState(null);
    }
  }

  async function loadRecentRun(run: RunBundleSummary): Promise<void> {
    setLoadingState("run");
    setErrorMessage(null);
    setPlaybackMode(null);
    setPlayheadMs(null);

    try {
      const loaded = await loadRunBundle(createRecentRunBundleReader(run));
      setBundle(loaded);
      setActiveRunId(run.runId);
      setSelectedStepIndex(defaultSelectedStepIndex(loaded));
      setActiveTab("session");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingState(null);
    }
  }

  function selectNode(nodeId: string): void {
    if (!bundle) {
      return;
    }
    setPlaybackMode(null);
    setPlayheadMs(null);
    const visibleSteps = bundle.steps.slice(0, effectiveStepIndex + 1);
    const visibleIndex = visibleSteps.map((step) => step.nodeId).lastIndexOf(nodeId);
    if (visibleIndex >= 0) {
      setSelectedStepIndex(visibleIndex);
      return;
    }
    const firstIndex = bundle.steps.findIndex((step) => step.nodeId === nodeId);
    if (firstIndex >= 0) {
      setSelectedStepIndex(firstIndex);
    }
  }

  return (
    <div className={`app-shell${runsCollapsed ? " app-shell--rail-collapsed" : ""}`}>
      <RunBrowser
        runs={recentRuns}
        activeRunId={activeRunId ?? undefined}
        collapsed={runsCollapsed}
        loading={loadingState === "runs" || loadingState === "bootstrap" || loadingState === "run"}
        directoryPickerSupported={isDirectoryPickerSupported()}
        onToggleCollapsed={() => {
          setRunsCollapsed((current) => !current);
        }}
        onRefresh={() => {
          void refreshRuns();
        }}
        onLoadSample={() => {
          void loadSample();
        }}
        onLoadRun={(run) => {
          void loadRecentRun(run);
        }}
        onOpenLocal={() => {
          void loadLocalBundle();
        }}
      />

      <main className="app-main">
        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <section className="viewer-layout">
          <section className="stage">
            {bundle ? (
              (() => {
                return (
                  <section className="canvas-card">
                    <div className="canvas-card__flow" style={{ minHeight: "360px" }}>
                      <ReactFlow
                        key={bundle.run.runId}
                        nodes={graph.nodes}
                        edges={graph.edges}
                        nodeTypes={nodeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.34, maxZoom: 1.02 }}
                        nodesDraggable={false}
                        nodesConnectable={false}
                        onNodeClick={(_, node: Node) => selectNode(node.id)}
                        minZoom={0.28}
                        maxZoom={1.35}
                        proOptions={{ hideAttribution: true }}
                      >
                        <Controls showInteractive={false} />
                        <Background color="rgba(148, 163, 184, 0.08)" gap={40} />
                      </ReactFlow>
                    </div>
                    <StepTimeline
                      steps={bundle.steps}
                      selectedIndex={effectiveStepIndex}
                      playbackValue={
                        playbackPreview?.playheadMs ??
                        (playbackTimeline
                          ? playbackAnchorMs(playbackTimeline, selectedStepIndex)
                          : 0)
                      }
                      playbackMax={playbackTimeline?.totalDurationMs ?? 0}
                      currentNodeLabel={
                        currentStep ? humanizeIdentifier(currentStep.nodeId) : "n/a"
                      }
                      currentMeta={currentDuration}
                      playing={playbackMode === "playing"}
                      onSelect={(index) => {
                        setPlaybackMode(null);
                        setPlayheadMs(null);
                        setSelectedStepIndex(index);
                      }}
                      onPlay={() => {
                        if (!playbackTimeline) {
                          return;
                        }
                        const resumeMs =
                          playheadMs ??
                          playbackAnchorMs(playbackTimeline, selectedStepIndex);
                        setPlayheadMs(resumeMs);
                        setPlaybackMode("playing");
                      }}
                      onPause={() => {
                        if (!playbackPreview) {
                          setPlaybackMode(null);
                          setPlayheadMs(null);
                          return;
                        }
                        setSelectedStepIndex(playbackPreview.nearestStepIndex);
                        setPlaybackMode(null);
                        setPlayheadMs(null);
                      }}
                      onReset={() => {
                        setPlaybackMode(null);
                        setPlayheadMs(null);
                        setSelectedStepIndex(0);
                      }}
                      onJumpToEnd={() => {
                        setPlaybackMode(null);
                        setPlayheadMs(null);
                        setSelectedStepIndex(Math.max(bundle.steps.length - 1, 0));
                      }}
                      onSeekStart={() => {
                        setPlaybackMode("seeking");
                        setPlayheadMs(
                          playbackPreview?.playheadMs ??
                            (playbackTimeline
                              ? playbackAnchorMs(playbackTimeline, selectedStepIndex)
                              : 0),
                        );
                      }}
                      onSeek={(value) => {
                        setPlayheadMs(value);
                      }}
                      onSeekCommit={(value) => {
                        if (!playbackTimeline) {
                          return;
                        }
                        const preview = derivePlaybackPreview(playbackTimeline, value);
                        setSelectedStepIndex(preview?.nearestStepIndex ?? selectedStepIndex);
                        setPlaybackMode(null);
                        setPlayheadMs(null);
                      }}
                    />
                  </section>
                );
              })()
            ) : (
              <div className="empty-state">
                <h2>Load a run bundle</h2>
                <p>
                  Start with the bundled sample, or open any saved run directory from
                  `~/.acpx/flows/runs/`.
                </p>
              </div>
            )}
          </section>

          <InspectorPanel
            selectedAttempt={selectedAttempt}
            sessionRevealProgress={sessionRevealProgress}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </section>
      </main>
    </div>
  );
}

function defaultSelectedStepIndex(bundle: LoadedRunBundle): number {
  return Math.max(bundle.steps.length - 1, 0);
}

function deriveStepDurationLabel(step: LoadedRunBundle["steps"][number]): string {
  return `${Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))} ms`;
}

function playbackProgressLabel(progress: number): string {
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}
