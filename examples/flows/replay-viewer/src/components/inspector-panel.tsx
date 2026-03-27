import { useEffect, useRef, type ReactNode } from "react";
import {
  formatDate,
  formatDuration,
  formatJson,
  revealConversationTranscript,
} from "../lib/view-model";
import type { SelectedAttemptView, SessionListItemView } from "../lib/view-model";

type InspectorPanelProps = {
  selectedAttempt: SelectedAttemptView | null;
  sessionItems: SessionListItemView[];
  activeSessionId: string | null;
  sessionRevealProgress: number | null;
  activeTab: "attempt" | "session" | "events";
  onTabChange(tab: "attempt" | "session" | "events"): void;
  onSessionChange(sessionId: string): void;
};

export function InspectorPanel({
  selectedAttempt,
  sessionItems,
  activeSessionId,
  sessionRevealProgress,
  activeTab,
  onTabChange,
  onSessionChange,
}: InspectorPanelProps) {
  if (!selectedAttempt) {
    return (
      <aside className="inspector">
        <div className="inspector__empty">
          Pick a step attempt to inspect the ACP conversation, attempt output, and trace events.
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector__tabs">
        <TabButton tab="session" activeTab={activeTab} onTabChange={onTabChange} />
        <TabButton tab="attempt" activeTab={activeTab} onTabChange={onTabChange} />
        <TabButton tab="events" activeTab={activeTab} onTabChange={onTabChange} />
      </div>

      <div className="inspector__body">
        {activeTab === "session" ? (
          <SessionTab
            selectedAttempt={selectedAttempt}
            sessionItems={sessionItems}
            activeSessionId={activeSessionId}
            sessionRevealProgress={sessionRevealProgress}
            onSessionChange={onSessionChange}
          />
        ) : null}
        {activeTab === "attempt" ? <AttemptTab selectedAttempt={selectedAttempt} /> : null}
        {activeTab === "events" ? <EventsTab selectedAttempt={selectedAttempt} /> : null}
      </div>
    </aside>
  );
}

function AttemptTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
  const { step } = selectedAttempt;

  return (
    <div className="inspector__section-stack">
      <Section
        title="Output"
        subtitle={`${formatDate(step.startedAt)} · ${formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}`}
      >
        <CodeBlock>{formatJson(step.output)}</CodeBlock>
      </Section>

      {step.promptText ? (
        <DisclosureSection title="Prompt text">
          <CodeBlock>{step.promptText}</CodeBlock>
        </DisclosureSection>
      ) : null}

      {step.rawText ? (
        <DisclosureSection title="Raw response">
          <CodeBlock>{step.rawText}</CodeBlock>
        </DisclosureSection>
      ) : null}

      {step.trace?.action ? (
        <DisclosureSection title="Action receipt">
          <CodeBlock>{formatJson(step.trace.action)}</CodeBlock>
        </DisclosureSection>
      ) : null}

      {step.error ? (
        <Section title="Error">
          <CodeBlock>{step.error}</CodeBlock>
        </Section>
      ) : null}
    </div>
  );
}

function SessionTab({
  selectedAttempt,
  sessionItems,
  activeSessionId,
  sessionRevealProgress,
  onSessionChange,
}: {
  selectedAttempt: SelectedAttemptView;
  sessionItems: SessionListItemView[];
  activeSessionId: string | null;
  sessionRevealProgress: number | null;
  onSessionChange(sessionId: string): void;
}) {
  const activeSession =
    sessionItems.find((session) => session.id === activeSessionId) ?? sessionItems[0] ?? null;
  const sessionEndRef = useRef<HTMLDivElement | null>(null);

  const renderedSessionSlice =
    activeSession?.isStreamingSource &&
    typeof sessionRevealProgress === "number"
      ? revealConversationTranscript(activeSession.sessionSlice, sessionRevealProgress)
      : activeSession?.sessionSlice ?? [];

  useEffect(() => {
    if (!activeSession || typeof sessionRevealProgress !== "number") {
      return;
    }
    sessionEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeSession, renderedSessionSlice, sessionRevealProgress]);

  if (!activeSession) {
    return (
      <div className="session-pane session-pane--empty">
        <div className="session-empty">This step did not use an ACP session.</div>
      </div>
    );
  }

  return (
    <div className="session-pane">
      {sessionItems.length > 1 ? (
        <div className="session-switcher" role="tablist" aria-label="ACP sessions">
          {sessionItems.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-switcher__button${session.id === activeSession.id ? " session-switcher__button--active" : ""}`}
              onClick={() => onSessionChange(session.id)}
            >
              {session.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="conversation">
        {renderedSessionSlice.map((message) => (
          <article
            key={`${message.index}-${message.role}`}
            className={`conversation__message conversation__message--${message.role}`}
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
        ))}
        <div ref={sessionEndRef} aria-hidden="true" />
      </div>
    </div>
  );
}

function EventsTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
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

function Section({
  title,
  subtitle,
  fill = false,
  children,
}: {
  title: string;
  subtitle?: string;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`panel-section${fill ? " panel-section--fill" : ""}`}>
      <div className="panel-section__header">
        <h3>{title}</h3>
        {subtitle ? <div className="panel-section__subtitle">{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function DisclosureSection({
  title,
  children,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <details className={`panel-disclosure${compact ? " panel-disclosure--compact" : ""}`}>
      <summary>{title}</summary>
      <div className="panel-disclosure__body">{children}</div>
    </details>
  );
}

function CodeBlock({ children }: { children: string }) {
  return <pre className="code-block">{children}</pre>;
}
