import { ReactFlow, type Node, type ReactFlowProps } from "@xyflow/react";
import { useNodeMeasurements } from "../hooks/use-node-measurements.js";

type MeasuredFlowProps = Omit<ReactFlowProps, "nodes" | "defaultNodes" | "onNodesChange"> & {
  nodes: Node[];
};

export function MeasuredFlow({ nodes, ...props }: MeasuredFlowProps) {
  // Keep DOM measurements when playback replaces the controlled graph data.
  const measured = useNodeMeasurements(nodes);
  return <ReactFlow {...props} nodes={measured.nodes} onNodesChange={measured.onNodesChange} />;
}
