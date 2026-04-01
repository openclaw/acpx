import { useEffect, useState } from "react";
import { formatJson } from "../../lib/view-model";
import type { SelectedAttemptView } from "../../lib/view-model";
import { CodeBlock, DisclosureSection } from "./common";

export function ConversationMessage({
  message,
  animate,
}: {
  message: SelectedAttemptView["sessionSlice"][number];
  animate: boolean;
}) {
  const [entered, setEntered] = useState(!animate);

  useEffect(() => {
    if (!animate) {
      setEntered(true);
      return;
    }

    setEntered(false);
    const frameId = window.requestAnimationFrame(() => {
      setEntered(true);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [animate, message.index, message.role]);

  return (
    <article
      className={`conversation__message conversation__message--${message.role}${entered ? " conversation__message--entered" : ""}`}
    >
      {message.parts.length > 0 ? (
        message.parts.map((part, index) => {
          if (part.kind === "text") {
            return (
              <div key={`${message.index}-text-${index}`} className="conversation__text">
                <p>{part.text}</p>
              </div>
            );
          }

          if (part.kind === "tool_use") {
            const toolUse = part.toolUse;
            return (
              <ToolEventCard
                key={toolUse.id}
                kind="call"
                title={toolUse.name}
                meta={toolUse.id}
                preview={toolUse.summary}
                raw={toolUse.raw}
              />
            );
          }

          if (part.kind === "tool_result") {
            const toolResult = part.toolResult;
            return (
              <ToolEventCard
                key={`${toolResult.id}-result`}
                kind="result"
                title={toolResult.toolName}
                meta={toolResult.id}
                status={toolResult.status}
                preview={toolResult.preview}
                raw={toolResult.raw}
                isError={toolResult.isError}
              />
            );
          }

          return (
            <DisclosureSection
              key={`${message.index}-payload-${index}`}
              title={part.payload.label}
              compact
            >
              <article className="conversation__tool-card">
                <CodeBlock>{formatJson(part.payload.raw)}</CodeBlock>
              </article>
            </DisclosureSection>
          );
        })
      ) : (
        <div className="conversation__empty-text">No visible text content.</div>
      )}
    </article>
  );
}

function ToolEventCard({
  kind,
  title,
  meta,
  status,
  preview,
  raw,
  isError = false,
}: {
  kind: "call" | "result";
  title: string;
  meta: string;
  status?: string;
  preview: string;
  raw: unknown;
  isError?: boolean;
}) {
  const statusTone = resolveToolStatusTone(status, isError);
  const label =
    kind === "call"
      ? "Tool call"
      : status
        ? `Tool result · ${formatToolStatus(status)}`
        : "Tool result";

  return (
    <details
      className={`conversation__tool-event conversation__tool-event--${kind}${isError ? " conversation__tool-event--error" : ""}`}
    >
      <summary className="conversation__tool-summary">
        <div className="conversation__tool-kicker">
          <span className={`conversation__tool-label conversation__tool-label--${statusTone}`}>
            {label}
          </span>
        </div>
        <div className="conversation__tool-title">{title}</div>
        <div
          className={`conversation__tool-preview${kind === "call" ? " conversation__tool-preview--call" : ""}`}
        >
          {preview}
        </div>
      </summary>
      <div className="conversation__tool-body">
        <dl className="conversation__tool-meta-list">
          <div>
            <dt>Kind</dt>
            <dd>{kind === "call" ? "Tool call" : "Tool result"}</dd>
          </div>
          {status ? (
            <div>
              <dt>Status</dt>
              <dd>{formatToolStatus(status)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Id</dt>
            <dd>{meta}</dd>
          </div>
        </dl>
        <section className="conversation__tool-section">
          <div className="conversation__tool-section-label">
            {kind === "call" ? "Invocation" : "Output preview"}
          </div>
          <div
            className={`conversation__tool-section-copy${kind === "call" ? " conversation__tool-section-copy--mono" : ""}`}
          >
            {preview}
          </div>
        </section>
        <section className="conversation__tool-section">
          <div className="conversation__tool-section-label">Raw payload</div>
          <CodeBlock>{formatJson(raw)}</CodeBlock>
        </section>
      </div>
    </details>
  );
}

function formatToolStatus(status: string): string {
  return status.replace(/_/g, " ").trim();
}

function resolveToolStatusTone(
  status: string | undefined,
  isError: boolean,
): "completed" | "running" | "error" | "neutral" {
  if (isError) {
    return "error";
  }
  if (!status) {
    return "neutral";
  }
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "ok" ||
    normalized === "completed" ||
    normalized === "done" ||
    normalized === "success"
  ) {
    return "completed";
  }
  if (normalized === "running" || normalized === "pending" || normalized === "in_progress") {
    return "running";
  }
  if (normalized === "error" || normalized === "failed" || normalized === "timed_out") {
    return "error";
  }
  return "neutral";
}
