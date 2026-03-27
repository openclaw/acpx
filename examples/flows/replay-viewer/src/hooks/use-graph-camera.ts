import type { ReactFlowInstance } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

type UseGraphCameraOptions = {
  runId: string | undefined;
  layoutKey: string;
  currentNodeId: string | null;
  currentNodePosition: { x: number; y: number } | null;
  viewMode: "follow" | "overview";
};

export const REPLAY_FIT_VIEW_OPTIONS = {
  padding: 0.56,
  minZoom: 0.08,
  maxZoom: 0.92,
  duration: 360,
  ease: easeOutCubic,
} as const;

export function useGraphCamera({
  runId,
  layoutKey,
  currentNodeId,
  currentNodePosition,
  viewMode,
}: UseGraphCameraOptions) {
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const lastFollowTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!flowInstance?.viewportInitialized || !runId || viewMode !== "overview") {
      return;
    }
    lastFollowTargetRef.current = null;

    let cancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      void flowInstance.fitView(REPLAY_FIT_VIEW_OPTIONS);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [flowInstance, layoutKey, runId, viewMode]);

  useEffect(() => {
    if (
      !flowInstance?.viewportInitialized ||
      !runId ||
      viewMode !== "follow" ||
      !currentNodeId ||
      !currentNodePosition
    ) {
      return;
    }
    const followTargetKey = `${runId}:${layoutKey}:${currentNodeId}`;
    if (lastFollowTargetRef.current === followTargetKey) {
      return;
    }
    lastFollowTargetRef.current = followTargetKey;

    let cancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }

      const internalNode = flowInstance.getInternalNode(currentNodeId);
      const width = internalNode?.measured?.width ?? internalNode?.width ?? 284;
      const height = internalNode?.measured?.height ?? internalNode?.height ?? 134;
      const centerX = currentNodePosition.x + width / 2;
      const centerY = currentNodePosition.y + height / 2 + 72;

      void flowInstance.setCenter(centerX, centerY, {
        zoom: 0.84,
        duration: 320,
        ease: easeOutCubic,
      });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [currentNodeId, currentNodePosition, flowInstance, layoutKey, runId, viewMode]);

  return {
    flowInstance,
    setFlowInstance,
  };
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}
