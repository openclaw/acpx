import { useEffect, useRef } from "react";
import { resolveSessionRenderState } from "../../lib/session-render-state";
import type { SelectedAttemptView, SessionListItemView } from "../../lib/view-model";
import { ConversationMessage } from "./conversation-message";

export function SessionTab({
  selectedAttempt,
  sessionItems,
  activeSessionId,
  sessionRevealProgress,
  liveStreaming,
  onSessionChange,
}: {
  selectedAttempt: SelectedAttemptView;
  sessionItems: SessionListItemView[];
  activeSessionId: string | null;
  sessionRevealProgress: number | null;
  liveStreaming: boolean;
  onSessionChange(sessionId: string): void;
}) {
  const activeSession =
    sessionItems.find((session) => session.id === activeSessionId) ?? sessionItems[0] ?? null;
  const sessionEndRef = useRef<HTMLDivElement | null>(null);

  const { renderedSessionSlice, animateConversation, autoFollowConversation } =
    resolveSessionRenderState({
      sessionSlice: activeSession?.sessionSlice ?? [],
      isStreamingSource: activeSession?.isStreamingSource ?? false,
      sessionRevealProgress,
      liveStreaming,
    });

  useEffect(() => {
    if (!activeSession || !autoFollowConversation) {
      return;
    }
    sessionEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeSession, autoFollowConversation, renderedSessionSlice]);

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
          <ConversationMessage
            key={`${message.index}-${message.role}`}
            message={message}
            animate={animateConversation}
          />
        ))}
        <div ref={sessionEndRef} aria-hidden="true" />
      </div>
    </div>
  );
}
