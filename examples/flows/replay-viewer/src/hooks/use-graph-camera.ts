import type { Node, ReactFlowInstance } from "@xyflow/react";
import { useEffect, useState } from "react";
import type { ViewerNodeData } from "../lib/view-model";

type UseGraphCameraOptions = {
  runId: string | undefined;
  nodes: Node<ViewerNodeData>[];
  layoutKey: string;
  currentNodeId: string | null;
  viewMode: "follow" | "overview";
};

export function useGraphCamera({
  runId,
  nodes,
  layoutKey,
  currentNodeId,
  viewMode,
}: UseGraphCameraOptions) {
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    if (!flowInstance?.viewportInitialized || !runId || viewMode !== "overview") {
      return;
    }

    let cancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      void flowInstance.fitView({
        padding: 0.34,
        maxZoom: 1.02,
        duration: 360,
        ease: easeOutCubic,
      });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [flowInstance, layoutKey, runId, viewMode]);

  useEffect(() => {
    if (!flowInstance?.viewportInitialized || !runId || viewMode !== "follow" || !currentNodeId) {
      return;
    }

    let cancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }

      const internalNode = flowInstance.getInternalNode(currentNodeId);
      const graphNode = nodes.find((node) => node.id === currentNodeId);
      if (!graphNode) {
        return;
      }

      const width = internalNode?.measured?.width ?? internalNode?.width ?? 284;
      const height = internalNode?.measured?.height ?? internalNode?.height ?? 134;
      const centerX = graphNode.position.x + width / 2;
      const centerY = graphNode.position.y + height / 2 + 72;

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
  }, [currentNodeId, flowInstance, layoutKey, nodes, runId, viewMode]);

  return {
    flowInstance,
    setFlowInstance,
  };
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}
