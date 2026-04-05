import { Handle, Position } from "@xyflow/react";
import type { ViewerNodeData } from "../lib/view-model.js";

type FlowNodeCardProps = {
  data: ViewerNodeData;
  selected?: boolean;
};

export function FlowNodeCard({ data, selected = false }: FlowNodeCardProps) {
  return (
    <div
      className={`flow-node-card flow-node-card--${data.status} flow-node-card--type-${data.nodeType}${selected ? " flow-node-card--selected" : ""}`}
    >
      {typeof data.playbackProgress === "number" ? (
        <div className="flow-node-card__progress" aria-hidden="true">
          <div
            className="flow-node-card__progress-fill"
            style={{ transform: `scaleX(${data.playbackProgress})` }}
          />
        </div>
      ) : null}
      <Handle
        id="in-top"
        type="target"
        position={Position.Top}
        className="flow-node-card__handle flow-node-card__handle--top"
      />
      <Handle
        id="in-left"
        type="target"
        position={Position.Left}
        className="flow-node-card__handle flow-node-card__handle--side"
      />
      <Handle
        id="in-right"
        type="target"
        position={Position.Right}
        className="flow-node-card__handle flow-node-card__handle--side"
      />
      <div className="flow-node-card__eyebrow">
        <div className="flow-node-card__badges">
          <span className="flow-node-card__type">{labelForNodeType(data.nodeType)}</span>
          {data.isStart ? <span className="flow-node-card__semantic">start</span> : null}
          {data.isDecision ? (
            <span className="flow-node-card__semantic">branch {data.branchCount}</span>
          ) : null}
          {data.isTerminal ? <span className="flow-node-card__semantic">end</span> : null}
        </div>
        <span className={`flow-node-card__status flow-node-card__status--${data.status}`}>
          {labelForStatus(data.status)}
        </span>
      </div>
      <div className="flow-node-card__title">{data.title}</div>
      <div className="flow-node-card__subtitle">{data.subtitle}</div>
      {data.isDecision && data.branchLabels.length > 0 ? (
        <div className="flow-node-card__routes">
          {data.branchLabels.slice(0, 4).map((label) => (
            <span key={`${data.nodeId}-${label}`} className="flow-node-card__route">
              {label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flow-node-card__meta">
        {data.attempts > 0 ? (
          <span>
            {data.attempts} attempt{data.attempts === 1 ? "" : "s"}
          </span>
        ) : (
          <span>not visited</span>
        )}
        {data.durationLabel ? <span>{data.durationLabel}</span> : null}
      </div>
      {data.runOutcomeLabel ? (
        <div
          className={`flow-node-card__outcome flow-node-card__outcome--${data.runOutcomeAccent ?? "active"}`}
        >
          {data.runOutcomeLabel}
        </div>
      ) : null}
      <Handle
        id="out-bottom"
        type="source"
        position={Position.Bottom}
        className="flow-node-card__handle flow-node-card__handle--bottom"
      />
      <Handle
        id="out-left"
        type="source"
        position={Position.Left}
        className="flow-node-card__handle flow-node-card__handle--side"
      />
      <Handle
        id="out-right"
        type="source"
        position={Position.Right}
        className="flow-node-card__handle flow-node-card__handle--side"
      />
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

function labelForNodeType(nodeType: ViewerNodeData["nodeType"]): string {
  switch (nodeType) {
    case "acp":
      return "ACP";
    case "action":
      return "Action";
    case "checkpoint":
      return "Checkpoint";
    case "compute":
    default:
      return "Compute";
  }
}
