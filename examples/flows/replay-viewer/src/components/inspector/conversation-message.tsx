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
      {message.textBlocks.length > 0 ? (
        <div className="conversation__text">
          {message.textBlocks.map((text, index) => (
            <p key={`${message.index}-text-${index}`}>{text}</p>
          ))}
        </div>
      ) : (
        <div className="conversation__empty-text">No visible text content.</div>
      )}

      {message.toolUses.length > 0 ? (
        <DisclosureSection title={`Tool calls (${message.toolUses.length})`} compact>
          <div className="conversation__tool-list">
            {message.toolUses.map((toolUse) => (
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
            ))}
          </div>
        </DisclosureSection>
      ) : null}

      {message.toolResults.length > 0 ? (
        <DisclosureSection title={`Tool results (${message.toolResults.length})`} compact>
          <div className="conversation__tool-list">
            {message.toolResults.map((toolResult) => (
              <article key={toolResult.id} className="conversation__tool-card">
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
            ))}
          </div>
        </DisclosureSection>
      ) : null}

      {message.hiddenPayloads.length > 0 ? (
        <DisclosureSection
          title={`Hidden structured data (${message.hiddenPayloads.length})`}
          compact
        >
          <div className="conversation__tool-list">
            {message.hiddenPayloads.map((payload, index) => (
              <article
                key={`${message.index}-payload-${index}`}
                className="conversation__tool-card"
              >
                <div className="conversation__tool-head">
                  <strong>{payload.label}</strong>
                </div>
                <CodeBlock>{formatJson(payload.raw)}</CodeBlock>
              </article>
            ))}
          </div>
        </DisclosureSection>
      ) : null}
    </article>
  );
}
