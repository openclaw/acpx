import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import { useEffect, useState } from "react";
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
  deriveRunOutcomeView,
  formatDuration,
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
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!bundle || !playing) {
      return undefined;
    }
    if (selectedStepIndex >= bundle.steps.length - 1) {
      setPlaying(false);
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setSelectedStepIndex((current) => {
        if (!bundle || current >= bundle.steps.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 950);
    return () => window.clearInterval(intervalId);
  }, [bundle, playing, selectedStepIndex]);

  const graph = bundle ? buildGraph(bundle, selectedStepIndex) : { nodes: [], edges: [] };
  const selectedAttempt = bundle ? selectAttemptView(bundle, selectedStepIndex) : null;

  async function bootstrap(): Promise<void> {
    setLoadingState("bootstrap");
    setErrorMessage(null);
    setPlaying(false);

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
    setPlaying(false);

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
    setPlaying(false);

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
    setPlaying(false);

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
    const visibleSteps = bundle.steps.slice(0, selectedStepIndex + 1);
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
        <header className="topbar">
          <div className="topbar__left">
            <div className="topbar__copy">
              <div className="hero__eyebrow">acpx flow replay</div>
              <h1>Trace Viewer</h1>
            </div>
          </div>
          {bundle ? (
            <div className="topbar__meta">
              <span className="topbar__pill">{bundle.run.flowName}</span>
              <span className={`topbar__pill topbar__pill--${bundle.run.status}`}>
                {bundle.run.status}
              </span>
              <span className="topbar__pill">
                {bundle.steps[selectedStepIndex]?.nodeId ?? bundle.live?.currentNode ?? "n/a"}
              </span>
              <span className="topbar__pill">{bundle.sourceLabel}</span>
            </div>
          ) : null}
        </header>

        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <section className="viewer-layout">
          <section className="stage">
            {bundle ? (
              (() => {
                const runOutcome = deriveRunOutcomeView(bundle);

                return (
                  <>
                    <section className="player-card">
                      <StepTimeline
                        steps={bundle.steps}
                        selectedIndex={selectedStepIndex}
                        playing={playing}
                        runOutcome={runOutcome}
                        onSelect={(index) => {
                          setPlaying(false);
                          setSelectedStepIndex(index);
                        }}
                        onPlay={() => {
                          if (selectedStepIndex >= bundle.steps.length - 1) {
                            setSelectedStepIndex(0);
                          }
                          setPlaying(true);
                        }}
                        onPause={() => setPlaying(false)}
                        onReset={() => {
                          setPlaying(false);
                          setSelectedStepIndex(0);
                        }}
                        onJumpToEnd={() => {
                          setPlaying(false);
                          setSelectedStepIndex(Math.max(bundle.steps.length - 1, 0));
                        }}
                        runStartedAt={bundle.run.startedAt}
                        runDurationLabel={formatDuration(
                          (bundle.run.finishedAt ? Date.parse(bundle.run.finishedAt) : Date.now()) -
                            Date.parse(bundle.run.startedAt),
                        )}
                      />
                    </section>

                    <section className="canvas-card">
                      <div className="canvas-card__header">
                        <div>
                          <div className="canvas-card__eyebrow">Graph replay</div>
                          <h2>{bundle.flow.name}</h2>
                        </div>
                        <div className="legend">
                          <span className="legend__item legend__item--completed">completed</span>
                          <span className="legend__item legend__item--active">selected</span>
                          <span className="legend__item legend__item--queued">queued</span>
                          <span className="legend__item legend__item--failed">problem</span>
                        </div>
                      </div>
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
                          <Background color="rgba(148, 163, 184, 0.12)" gap={36} />
                        </ReactFlow>
                      </div>
                    </section>
                  </>
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
