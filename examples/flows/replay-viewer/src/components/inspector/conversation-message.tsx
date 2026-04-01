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
              <article key={toolUse.id} className="conversation__tool-card">
                <div className="conversation__tool-head">
                  <strong>{toolUse.name}</strong>
                  <span>{toolUse.id}</span>
                </div>
                <p>{toolUse.summary}</p>
                <details className="conversation__nested-details">
                  <summary>Raw tool call</summary>
                  <CodeBlock>{formatJson(toolUse.raw)}</CodeBlock>
                </details>
              </article>
            );
          }

          if (part.kind === "tool_result") {
            const toolResult = part.toolResult;
            return (
              <article key={`${toolResult.id}-result`} className="conversation__tool-card">
                <div className="conversation__tool-head">
                  <strong>{toolResult.toolName}</strong>
                  <span>{toolResult.status}</span>
                </div>
                <p>{toolResult.preview}</p>
                <details className="conversation__nested-details">
                  <summary>Raw tool result</summary>
                  <CodeBlock>{formatJson(toolResult.raw)}</CodeBlock>
                </details>
              </article>
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
