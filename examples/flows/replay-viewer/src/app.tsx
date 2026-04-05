import { Background, Controls, ReactFlow, type Node } from "@xyflow/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FlowNodeCard } from "./components/flow-node-card.js";
import { InspectorPanel } from "./components/inspector-panel.js";
import { RoutedFlowEdge } from "./components/routed-flow-edge.js";
import { RunBrowser } from "./components/run-browser.js";
import { StepTimeline } from "./components/step-timeline.js";
import { REPLAY_FIT_VIEW_OPTIONS, useGraphCamera } from "./hooks/use-graph-camera.js";
import { useGraphLayout } from "./hooks/use-graph-layout.js";
import { PLAYBACK_SPEED_OPTIONS, usePlaybackController } from "./hooks/use-playback-controller.js";
import { useRunBundleLoader } from "./hooks/use-run-bundle-loader.js";
import {
  buildGraph,
  humanizeIdentifier,
  listSessionViews,
  playbackSelectionMs,
  selectAttemptView,
} from "./lib/view-model.js";
import type { LoadedRunBundle } from "./types.js";

const nodeTypes = {
  flowNode: FlowNodeCard,
};

const edgeTypes = {
  routedFlow: RoutedFlowEdge,
};

export function App() {
  const { bundle, recentRuns, activeRunId, loadingState, errorMessage, bootstrap, loadRecentRun } =
    useRunBundleLoader();
  const playback = usePlaybackController(bundle);
  const graphLayout = useGraphLayout(bundle);
  const [activeTab, setActiveTab] = useState<"attempt" | "session" | "events">("session");
  const [runsCollapsed, setRunsCollapsed] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"follow" | "overview">("follow");

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    setActiveTab("session");
    setViewMode("follow");
  }, [bundle?.run.runId]);

  const graph = bundle
    ? buildGraph(bundle, playback.effectiveStepIndex, playback.playbackPreview, graphLayout)
    : { nodes: [], edges: [] };
  const graphLayoutKey = useMemo(
    () => graph.nodes.map((node) => `${node.id}:${node.position.x}:${node.position.y}`).join("|"),
    [graph.nodes],
  );
  const selectedAttempt = useMemo(
    () => (bundle ? selectAttemptView(bundle, playback.effectiveStepIndex) : null),
    [bundle, playback.effectiveStepIndex],
  );
  const sessionItems = useMemo(
    () => (bundle && selectedAttempt ? listSessionViews(bundle, selectedAttempt) : []),
    [bundle, selectedAttempt],
  );
  const currentStep = bundle?.steps[playback.effectiveStepIndex] ?? null;
  const currentDuration = currentStep
    ? `${playback.effectiveStepIndex + 1} / ${bundle?.steps.length ?? 0} · ${currentStep.nodeType} · ${playback.playbackPreview ? playbackProgressLabel(playback.playbackPreview.stepProgress) : deriveStepDurationLabel(currentStep)}`
    : "n/a";
  const sessionRevealProgress =
    playback.playbackPreview && selectedAttempt?.step.attemptId === currentStep?.attemptId
      ? playback.playbackPreview.stepProgress
      : null;
  const liveStreamingSession =
    bundle?.run.status === "running" &&
    bundle.run.currentAttemptId != null &&
    selectedAttempt?.step.attemptId === bundle.run.currentAttemptId &&
    selectedAttempt.step.nodeType === "acp";
  const waitingForRecentRuns = loadingState === "bootstrap" || loadingState === "runs";
  const currentNodeId = currentStep?.nodeId ?? graph.nodes[0]?.id ?? null;
  const currentNodePosition = useMemo(() => {
    if (!currentNodeId) {
      return null;
    }
    const node = graph.nodes.find((candidate) => candidate.id === currentNodeId);
    return node ? { x: node.position.x, y: node.position.y } : null;
  }, [currentNodeId, graphLayoutKey]);
  const playbackValue =
    playback.playbackPreview?.playheadMs ??
    (playback.playbackTimeline
      ? playbackSelectionMs(
          playback.playbackTimeline,
          playback.selectedStepIndex,
          bundle?.steps.length ?? 0,
        )
      : 0) ??
    0;

  const { setFlowInstance } = useGraphCamera({
    runId: bundle?.run.runId,
    layoutKey: graphLayoutKey,
    currentNodeId,
    currentNodePosition,
    viewMode,
  });

  useEffect(() => {
    const defaultSessionId =
      selectedAttempt?.sessionSourceStep?.trace?.conversation?.sessionId ??
      selectedAttempt?.sessionSourceStep?.trace?.sessionId ??
      sessionItems[0]?.id ??
      null;
    setActiveSessionId(defaultSessionId);
  }, [
    selectedAttempt?.step.attemptId,
    selectedAttempt?.sessionSourceStep?.attemptId,
    sessionItems[0]?.id,
  ]);

  function selectNode(nodeId: string): void {
    if (!bundle) {
      return;
    }
    playback.clearPlayback();
    const visibleSteps = bundle.steps.slice(0, playback.effectiveStepIndex + 1);
    const visibleIndex = visibleSteps.map((step) => step.nodeId).lastIndexOf(nodeId);
    if (visibleIndex >= 0) {
      playback.selectStep(visibleIndex);
      return;
    }
    const firstIndex = bundle.steps.findIndex((step) => step.nodeId === nodeId);
    if (firstIndex >= 0) {
      playback.selectStep(firstIndex);
    }
  }

  return (
    <div className={`app-shell${runsCollapsed ? " app-shell--rail-collapsed" : ""}`}>
      <RunBrowser
        runs={recentRuns}
        activeRunId={activeRunId ?? undefined}
        collapsed={runsCollapsed}
        loading={loadingState === "runs" || loadingState === "bootstrap" || loadingState === "run"}
        onToggleCollapsed={() => {
          setRunsCollapsed((current) => !current);
        }}
        onLoadRun={(run) => {
          void loadRecentRun(run);
        }}
      />

      <main className="app-main">
        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <section className="viewer-layout">
          <section className="stage">
            {bundle ? (
              <section className="canvas-card">
                <div className="canvas-card__flow" style={{ minHeight: "360px" }}>
                  <ReactFlow
                    key={bundle.run.runId}
                    nodes={graph.nodes}
                    edges={graph.edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    defaultViewport={{ x: 0, y: 0, zoom: 0.84 }}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    onInit={setFlowInstance}
                    onNodeClick={(_, node: Node) => selectNode(node.id)}
                    minZoom={REPLAY_FIT_VIEW_OPTIONS.minZoom}
                    maxZoom={1.35}
                    fitViewOptions={REPLAY_FIT_VIEW_OPTIONS}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Controls
                      showInteractive={false}
                      fitViewOptions={REPLAY_FIT_VIEW_OPTIONS}
                      onFitView={() => {
                        setViewMode("overview");
                      }}
                    />
                    <Background color="rgba(148, 163, 184, 0.08)" gap={40} />
                  </ReactFlow>
                  <div className="canvas-card__camera">
                    <div
                      className="timeline__mode-switcher"
                      role="tablist"
                      aria-label="Camera mode"
                    >
                      <ModeButton
                        label="Follow current node"
                        active={viewMode === "follow"}
                        onClick={() => setViewMode("follow")}
                      >
                        <FollowIcon />
                        <span>Follow</span>
                      </ModeButton>
                      <ModeButton
                        label="Overview"
                        active={viewMode === "overview"}
                        onClick={() => setViewMode("overview")}
                      >
                        <OverviewIcon />
                        <span>Overview</span>
                      </ModeButton>
                    </div>
                  </div>
                </div>
                <StepTimeline
                  steps={bundle.steps}
                  selectedIndex={playback.effectiveStepIndex}
                  playbackValue={playbackValue}
                  playbackMax={playback.playbackTimeline?.totalDurationMs ?? 0}
                  playbackRate={playback.playbackRate}
                  playbackSpeedOptions={PLAYBACK_SPEED_OPTIONS}
                  currentNodeLabel={currentStep ? humanizeIdentifier(currentStep.nodeId) : "n/a"}
                  currentMeta={currentDuration}
                  playing={playback.isPlaying}
                  onSelect={playback.selectStep}
                  onPlay={playback.play}
                  onPause={playback.pause}
                  onReset={playback.reset}
                  onJumpToEnd={playback.jumpToEnd}
                  onSeekStart={playback.startSeek}
                  onSeek={playback.seek}
                  onSeekCommit={playback.commitSeek}
                  onPlaybackRateChange={playback.setPlaybackRate}
                />
              </section>
            ) : (
              <div className="empty-state">
                <h2>{waitingForRecentRuns ? "Watching for recent runs…" : "No recent runs yet"}</h2>
                <p>
                  {waitingForRecentRuns
                    ? "The viewer is connected. Start a flow and it will open here automatically."
                    : "Start a flow. The left sidebar will pick it up and open it automatically."}
                </p>
              </div>
            )}
          </section>

          <InspectorPanel
            selectedAttempt={selectedAttempt}
            sessionItems={sessionItems}
            activeSessionId={activeSessionId}
            sessionRevealProgress={sessionRevealProgress}
            liveStreaming={liveStreamingSession}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onSessionChange={setActiveSessionId}
          />
        </section>
      </main>
    </div>
  );
}

function deriveStepDurationLabel(step: LoadedRunBundle["steps"][number]): string {
  return `${Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))} ms`;
}

function playbackProgressLabel(progress: number): string {
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

function ModeButton({
  children,
  label,
  active,
  onClick,
}: {
  children: ReactNode;
  label: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`timeline__mode-button${active ? " timeline__mode-button--active" : ""}`}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function FollowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 9h8" />
      <path d="M8 12h4" />
      <path d="M8 15h6" />
    </svg>
  );
}
