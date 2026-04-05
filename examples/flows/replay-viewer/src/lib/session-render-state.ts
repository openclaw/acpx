import type { SelectedAttemptView } from "./view-model-types.js";
import { revealConversationTranscript } from "./view-model.js";

export type SessionRenderState = {
  renderedSessionSlice: SelectedAttemptView["sessionSlice"];
  animateConversation: boolean;
  autoFollowConversation: boolean;
};

export function resolveSessionRenderState(options: {
  sessionSlice: SelectedAttemptView["sessionSlice"];
  isStreamingSource: boolean;
  sessionRevealProgress: number | null;
  liveStreaming: boolean;
}): SessionRenderState {
  const { sessionSlice, isStreamingSource, sessionRevealProgress, liveStreaming } = options;

  if (isStreamingSource && liveStreaming) {
    return {
      renderedSessionSlice: sessionSlice,
      animateConversation: false,
      autoFollowConversation: true,
    };
  }

  if (isStreamingSource && typeof sessionRevealProgress === "number") {
    return {
      renderedSessionSlice: revealConversationTranscript(sessionSlice, sessionRevealProgress),
      animateConversation: true,
      autoFollowConversation: true,
    };
  }

  return {
    renderedSessionSlice: sessionSlice,
    animateConversation: false,
    autoFollowConversation: false,
  };
}
