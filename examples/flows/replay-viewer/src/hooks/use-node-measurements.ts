import type { Dimensions, Node, OnNodesChange } from "@xyflow/react";
import { useCallback, useState } from "react";

export function useNodeMeasurements<NodeType extends Node>(nodes: NodeType[]) {
  const [measurements, setMeasurements] = useState(() => new Map<string, Dimensions>());
  const onNodesChange = useCallback<OnNodesChange<NodeType>>((changes) => {
    setMeasurements((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions) {
          continue;
        }
        const measured = next.get(change.id);
        if (
          measured?.width === change.dimensions.width &&
          measured?.height === change.dimensions.height
        ) {
          continue;
        }
        if (next === current) {
          next = new Map(current);
        }
        next.set(change.id, { ...change.dimensions });
      }
      return next;
    });
  }, []);

  return {
    measurements: measurements as ReadonlyMap<string, Dimensions>,
    nodes: nodes.map((node) => {
      const measured = measurements.get(node.id);
      return measured ? { ...node, measured } : node;
    }),
    onNodesChange,
  };
}
