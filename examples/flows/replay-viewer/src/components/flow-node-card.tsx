import { Handle, Position } from "@xyflow/react";
import type { ViewerNodeData } from "../lib/view-model";

type FlowNodeCardProps = {
  data: ViewerNodeData;
  selected?: boolean;
};

export function FlowNodeCard({ data, selected = false }: FlowNodeCardProps) {
  return (
    <div
      className={`flow-node-card flow-node-card--${data.status}${selected ? " flow-node-card--selected" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="flow-node-card__handle" />
      <div className="flow-node-card__eyebrow">
        <span className="flow-node-card__type">{data.nodeType}</span>
        <span className={`flow-node-card__status flow-node-card__status--${data.status}`}>
          {labelForStatus(data.status)}
        </span>
      </div>
      <div className="flow-node-card__title">{data.nodeId}</div>
      <div className="flow-node-card__meta">
        <span>
          {data.attempts} attempt{data.attempts === 1 ? "" : "s"}
        </span>
        {data.durationLabel ? <span>{data.durationLabel}</span> : null}
      </div>
      {data.handleLabel ? <div className="flow-node-card__session">{data.handleLabel}</div> : null}
      <Handle type="source" position={Position.Bottom} className="flow-node-card__handle" />
    </div>
  );
}

function labelForStatus(status: ViewerNodeData["status"]): string {
  switch (status) {
    case "queued":
      return "queued";
    case "active":
      return "focus";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "timed_out":
      return "timed out";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}
