import type { ReactNode } from "react";
import { formatDate, formatDuration, formatJson } from "../lib/view-model";
import type { SelectedAttemptView } from "../lib/view-model";

type InspectorPanelProps = {
  selectedAttempt: SelectedAttemptView | null;
  activeTab: "attempt" | "session" | "events";
  onTabChange(tab: "attempt" | "session" | "events"): void;
};

export function InspectorPanel({ selectedAttempt, activeTab, onTabChange }: InspectorPanelProps) {
  if (!selectedAttempt) {
    return (
      <aside className="inspector">
        <div className="inspector__empty">
          Pick a step attempt to inspect its prompt, ACP session slice, and replay data.
        </div>
      </aside>
    );
  }

  const { step } = selectedAttempt;

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <div>
          <div className="inspector__eyebrow">{step.kind} attempt</div>
          <h2 className="inspector__title">{step.nodeId}</h2>
          <div className="inspector__subtitle">{step.attemptId}</div>
        </div>
        <span className={`outcome-pill outcome-pill--${step.outcome}`}>{step.outcome}</span>
      </div>

      <div className="inspector__meta">
        <div>
          <span className="inspector__meta-label">Started</span>
          <span>{formatDate(step.startedAt)}</span>
        </div>
        <div>
          <span className="inspector__meta-label">Finished</span>
          <span>{formatDate(step.finishedAt)}</span>
        </div>
        <div>
          <span className="inspector__meta-label">Duration</span>
          <span>{formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}</span>
        </div>
      </div>

      <div className="inspector__tabs">
        <TabButton tab="attempt" activeTab={activeTab} onTabChange={onTabChange} />
        <TabButton tab="session" activeTab={activeTab} onTabChange={onTabChange} />
        <TabButton tab="events" activeTab={activeTab} onTabChange={onTabChange} />
      </div>

      {activeTab === "attempt" ? <AttemptTab selectedAttempt={selectedAttempt} /> : null}
      {activeTab === "session" ? <SessionTab selectedAttempt={selectedAttempt} /> : null}
      {activeTab === "events" ? <EventsTab selectedAttempt={selectedAttempt} /> : null}
    </aside>
  );
}

function AttemptTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
  const { step } = selectedAttempt;

  return (
    <div className="inspector__section-stack">
      <Section title="Parsed output">
        <CodeBlock>{formatJson(step.output)}</CodeBlock>
      </Section>

      {step.promptText ? (
        <Section title="Prompt text">
          <CodeBlock>{step.promptText}</CodeBlock>
        </Section>
      ) : null}

      {step.rawText ? (
        <Section title="Raw response">
          <CodeBlock>{step.rawText}</CodeBlock>
        </Section>
      ) : null}

      {step.trace?.action ? (
        <Section title="Action receipt">
          <CodeBlock>{formatJson(step.trace.action)}</CodeBlock>
        </Section>
      ) : null}

      {step.error ? (
        <Section title="Error">
          <CodeBlock>{step.error}</CodeBlock>
        </Section>
      ) : null}
    </div>
  );
}

function SessionTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
  const { step, sessionRecord, sessionSlice } = selectedAttempt;

  if (!sessionRecord) {
    return (
      <div className="inspector__section-stack">
        <Section title="ACP session">
          <div className="empty-card">This step did not use an ACP session.</div>
        </Section>
      </div>
    );
  }

  return (
    <div className="inspector__section-stack">
      <Section title="Session metadata">
        <dl className="definition-grid">
          <div>
            <dt>Name</dt>
            <dd>{step.session?.name ?? sessionRecord.name ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Session id</dt>
            <dd>{step.trace?.conversation?.sessionId ?? step.trace?.sessionId ?? "n/a"}</dd>
          </div>
          <div>
            <dt>cwd</dt>
            <dd>{sessionRecord.cwd ?? step.agent?.cwd ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Agent command</dt>
            <dd>{sessionRecord.agentCommand ?? step.agent?.agentCommand ?? "n/a"}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Conversation">
        <div className="conversation">
          {sessionSlice.map((message) => (
            <article
              key={`${message.index}-${message.role}`}
              className={`conversation__message conversation__message--${message.role}${message.highlighted ? " conversation__message--highlighted" : ""}`}
            >
              <div className="conversation__meta">
                <span>{message.title}</span>
                <span>#{message.index}</span>
              </div>
              <pre>{message.text}</pre>
            </article>
          ))}
        </div>
      </Section>
    </div>
  );
}

function EventsTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
  return (
    <div className="inspector__section-stack">
      <Section title="Trace events for this attempt">
        <div className="event-list">
          {selectedAttempt.traceEvents.map((event) => (
            <article key={`${event.seq}-${event.type}`} className="event-card">
              <div className="event-card__meta">
                <span>{event.seq}</span>
                <span>{event.scope}</span>
                <span>{event.type}</span>
              </div>
              <CodeBlock>{formatJson(event.payload)}</CodeBlock>
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
              <CodeBlock>{formatJson(event.message)}</CodeBlock>
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

function TabButton({
  tab,
  activeTab,
  onTabChange,
}: {
  tab: "attempt" | "session" | "events";
  activeTab: "attempt" | "session" | "events";
  onTabChange(tab: "attempt" | "session" | "events"): void;
}) {
  return (
    <button
      type="button"
      className={`tab-button${tab === activeTab ? " tab-button--active" : ""}`}
      onClick={() => onTabChange(tab)}
    >
      {tab}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return <pre className="code-block">{children}</pre>;
}
