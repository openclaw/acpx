import { BaseEdge, type EdgeProps } from "@xyflow/react";
import type { ViewerEdgeData } from "../lib/view-model.js";

export function RoutedFlowEdge({
  id,
  data,
  markerEnd,
  style,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps) {
  const points = dataPoints(data, sourceX, sourceY, targetX, targetY);
  const path = buildPolylinePath(points);

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}

function dataPoints(
  data: unknown,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
) {
  const viewerData = data as ViewerEdgeData | undefined;
  if (viewerData?.points && viewerData.points.length >= 2) {
    return viewerData.points;
  }
  return [
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
  ];
}

function buildPolylinePath(points: Array<{ x: number; y: number }>): string {
  const [first, ...rest] = points;
  if (!first) {
    return "";
  }

  let path = `M ${first.x} ${first.y}`;
  for (const point of rest) {
    path += ` L ${point.x} ${point.y}`;
  }
  return path;
}
