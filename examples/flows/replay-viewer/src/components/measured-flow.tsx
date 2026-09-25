import { ReactFlow, type Dimensions, type Node, type ReactFlowProps } from "@xyflow/react";
import { useEffect } from "react";
import { useNodeMeasurements } from "../hooks/use-node-measurements.js";

type MeasuredFlowProps = Omit<ReactFlowProps, "nodes" | "defaultNodes" | "onNodesChange"> & {
  nodes: Node[];
  runId: string;
  onMeasurements: (runId: string, measurements: ReadonlyMap<string, Dimensions>) => void;
};

export function MeasuredFlow({ nodes, runId, onMeasurements, ...props }: MeasuredFlowProps) {
  // Keep DOM measurements when playback replaces the controlled graph data.
  const measured = useNodeMeasurements(nodes);
  useEffect(() => {
    onMeasurements(runId, measured.measurements);
  }, [runId, measured.measurements, onMeasurements]);
  return <ReactFlow {...props} nodes={measured.nodes} onNodesChange={measured.onNodesChange} />;
}
