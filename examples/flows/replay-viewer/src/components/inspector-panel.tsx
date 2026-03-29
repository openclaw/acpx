import type { SelectedAttemptView, SessionListItemView } from "../lib/view-model";
import { AttemptTab } from "./inspector/attempt-tab";
import { EventsTab } from "./inspector/events-tab";
import { SessionTab } from "./inspector/session-tab";

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
