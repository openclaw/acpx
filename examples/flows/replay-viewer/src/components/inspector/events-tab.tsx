import { formatJson } from "../../lib/view-model.js";
import type { SelectedAttemptView } from "../../lib/view-model.js";
import { CodeBlock, Section } from "./common.js";

export function EventsTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
  return (
    <div className="inspector__section-stack">
      <Section title="Trace events">
        <div className="event-list">
          {selectedAttempt.traceEvents.map((event) => (
            <article key={`${event.seq}-${event.type}`} className="event-card">
              <div className="event-card__meta">
                <span>{event.seq}</span>
                <span>{event.scope}</span>
                <span>{event.type}</span>
              </div>
              <details className="conversation__nested-details">
                <summary>Show payload</summary>
                <CodeBlock>{formatJson(event.payload)}</CodeBlock>
              </details>
            </article>
          ))}
          {selectedAttempt.traceEvents.length === 0 ? (
            <div className="empty-card">No trace events were captured for this attempt.</div>
          ) : null}
        </div>
      </Section>

      <Section title="Bundled ACP event slice">
        <div className="event-list">
          {selectedAttempt.rawEventSlice.map((event) => (
            <article key={`${event.seq}-${event.direction}`} className="event-card">
              <div className="event-card__meta">
                <span>{event.seq}</span>
                <span>{event.direction}</span>
              </div>
              <details className="conversation__nested-details">
                <summary>Show event payload</summary>
                <CodeBlock>{formatJson(event.message)}</CodeBlock>
              </details>
            </article>
          ))}
          {selectedAttempt.rawEventSlice.length === 0 ? (
            <div className="empty-card">This attempt has no bundled ACP event slice.</div>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
