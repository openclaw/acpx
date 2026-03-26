import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import { useEffect, useState } from "react";
import { FlowNodeCard } from "./components/flow-node-card";
import { InspectorPanel } from "./components/inspector-panel";
import { StepTimeline } from "./components/step-timeline";
import {
  createDirectoryBundleReader,
  createSampleBundleReader,
  isDirectoryPickerSupported,
} from "./lib/bundle-reader";
import { loadRunBundle } from "./lib/load-bundle";
import { buildGraph, formatDate, formatDuration, selectAttemptView } from "./lib/view-model";
import type { LoadedRunBundle } from "./types";

const nodeTypes = {
  flowNode: FlowNodeCard,
};

export function App() {
  const [bundle, setBundle] = useState<LoadedRunBundle | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<"attempt" | "session" | "events">("attempt");
  const [loadingState, setLoadingState] = useState<"sample" | "local" | null>("sample");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    void loadSample();
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

  async function loadSample(): Promise<void> {
    setLoadingState("sample");
    setErrorMessage(null);
    setPlaying(false);

    try {
      const loaded = await loadRunBundle(createSampleBundleReader());
      setBundle(loaded);
      setSelectedStepIndex(defaultSelectedStepIndex(loaded));
      setActiveTab("attempt");
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
      setSelectedStepIndex(defaultSelectedStepIndex(loaded));
      setActiveTab("attempt");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
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
    <div className="app-shell">
      <header className="hero">
        <div>
          <div className="hero__eyebrow">acpx flow replay</div>
          <h1>Trace Viewer</h1>
          <p>
            Replay a flow run step by step, see the graph progression, and inspect the ACP session
            slice that powered each ACP node.
          </p>
        </div>
        <div className="hero__actions">
          <button type="button" className="primary-button" onClick={() => void loadSample()}>
            {loadingState === "sample" ? "Loading sample…" : "Load bundled sample"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void loadLocalBundle()}
            disabled={!isDirectoryPickerSupported() || loadingState === "local"}
          >
            {loadingState === "local" ? "Opening bundle…" : "Open local run bundle"}
          </button>
        </div>
      </header>

      {bundle ? (
        <section className="run-summary">
          <div className="summary-card">
            <span className="summary-card__label">Run</span>
            <span className="summary-card__value">{bundle.manifest.runId}</span>
          </div>
          <div className="summary-card">
            <span className="summary-card__label">Flow</span>
            <span className="summary-card__value">{bundle.run.flowName}</span>
          </div>
          <div className="summary-card">
            <span className="summary-card__label">Status</span>
            <span className={`summary-card__value summary-card__value--${bundle.run.status}`}>
              {bundle.run.status}
            </span>
          </div>
          <div className="summary-card">
            <span className="summary-card__label">Duration</span>
            <span className="summary-card__value">
              {formatDuration(
                (bundle.run.finishedAt ? Date.parse(bundle.run.finishedAt) : Date.now()) -
                  Date.parse(bundle.run.startedAt),
              )}
            </span>
          </div>
          <div className="summary-card">
            <span className="summary-card__label">Started</span>
            <span className="summary-card__value">{formatDate(bundle.run.startedAt)}</span>
          </div>
          <div className="summary-card">
            <span className="summary-card__label">Source</span>
            <span className="summary-card__value">{bundle.sourceLabel}</span>
          </div>
        </section>
      ) : null}

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <main className="workspace">
        <section className="canvas-card">
          {bundle ? (
            <>
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
              <div className="canvas-card__flow">
                <ReactFlow
                  nodes={graph.nodes}
                  edges={graph.edges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onNodeClick={(_, node: Node) => selectNode(node.id)}
                  minZoom={0.45}
                  maxZoom={1.5}
                  proOptions={{ hideAttribution: true }}
                >
                  <Controls showInteractive={false} />
                  <Background color="rgba(25, 48, 67, 0.07)" gap={22} />
                </ReactFlow>
              </div>
              <StepTimeline
                steps={bundle.steps}
                selectedIndex={selectedStepIndex}
                playing={playing}
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
              />
            </>
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
      </main>
    </div>
  );
}

function defaultSelectedStepIndex(bundle: LoadedRunBundle): number {
  const lastAcpStepIndex = bundle.steps.findLastIndex((step) => step.kind === "acp");
  if (lastAcpStepIndex >= 0) {
    return lastAcpStepIndex;
  }
  return Math.max(bundle.steps.length - 1, 0);
}
