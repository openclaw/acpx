import { useEffect, useState } from "react";
import { formatJson } from "../../lib/view-model.js";
import type { SelectedAttemptView } from "../../lib/view-model.js";
import { CodeBlock, DisclosureSection } from "./common.js";

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
          if (part.type === "text") {
            return (
              <div key={`${message.index}-text-${index}`} className="conversation__text">
                <p>{part.text}</p>
              </div>
            );
          }

          if (part.type === "tool_use") {
            const toolUse = part.toolUse;
            return (
              <ToolEventCard
                key={toolUse.id}
                variant="call"
                title={toolUse.name}
                preview={toolUse.summary}
                raw={toolUse.raw}
              />
            );
          }

          if (part.type === "tool_result") {
            const toolResult = part.toolResult;
            return (
              <ToolEventCard
                key={`${toolResult.id}-result`}
                variant="result"
                title={toolResult.toolName}
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
  variant,
  title,
  status,
  preview,
  raw,
  isError = false,
}: {
  variant: "call" | "result";
  title: string;
  status?: string;
  preview: string;
  raw: unknown;
  isError?: boolean;
}) {
  const statusTone = resolveToolStatusTone(status, isError);

  return (
    <details
      className={`conversation__tool-event conversation__tool-event--${variant} conversation__tool-event--${statusTone}${isError ? " conversation__tool-event--error" : ""}`}
    >
      <summary className="conversation__tool-summary">
        <div className="conversation__tool-title">{title}</div>
        <div
          className={`conversation__tool-preview${variant === "call" ? " conversation__tool-preview--call" : ""}`}
        >
          {preview}
        </div>
      </summary>
      <div className="conversation__tool-body">
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
