import { promptToDisplayText } from "../../../../../src/prompt-content.js";
import type { FlowConversationTrace, FlowStepRecord, LoadedRunBundle } from "../types.js";
import {
  projectConversationRange,
  projectSession,
  promptInInterval,
  type ProjectionInterval,
  type SessionProjection,
} from "./session-projection.js";

type CurrentSessionProjection = {
  sessionId: string;
  interval: FlowConversationTrace;
  projection: SessionProjection;
};

export function projectRunBundle<T extends LoadedRunBundle>(bundle: T): T {
  const next = structuredClone(bundle);
  const currentSessionId = hasUnrecordedCurrentAttempt(next) ? resolveCurrentSessionId(next) : null;
  let current: CurrentSessionProjection | undefined;

  for (const session of Object.values(next.sessions)) {
    const settled = sessionIntervals(next.steps, session.id);
    const active =
      session.id === currentSessionId ? currentInterval(session.id, session.events, settled) : null;
    const intervals: ProjectionInterval[] = active
      ? [
          ...settled,
          {
            eventStartSeq: active.eventStartSeq,
            eventEndSeq: active.eventEndSeq,
            pending: true,
          },
        ]
      : settled;
    const projection = projectSession(
      session.id,
      session.record,
      session.events,
      intervals,
      next.run.startedAt,
    );
    session.record = projection.record;
    next.steps = next.steps.map((step) => projectStep(step, session.id, projection));
    if (active) {
      current = { sessionId: session.id, interval: active, projection };
    }
  }

  if (hasUnrecordedCurrentAttempt(next)) {
    next.steps.push(createCurrentStep(next, current));
  }
  next.run.steps = next.steps;
  if (next.live) {
    next.live.steps = next.steps;
  }
  return next;
}

function projectStep(
  step: FlowStepRecord,
  sessionId: string,
  projection: SessionProjection,
): FlowStepRecord {
  const conversation = step.trace?.conversation;
  if (!conversation || conversation.sessionId !== sessionId) {
    return step;
  }
  return {
    ...step,
    trace: {
      ...step.trace,
      conversation: projectConversationRange(projection, conversation),
    },
  };
}

function sessionIntervals(steps: FlowStepRecord[], sessionId: string): ProjectionInterval[] {
  return steps.flatMap((step) => {
    const range = step.trace?.conversation;
    return range?.sessionId === sessionId
      ? [{ eventStartSeq: range.eventStartSeq, eventEndSeq: range.eventEndSeq }]
      : [];
  });
}

function currentInterval(
  sessionId: string,
  events: LoadedRunBundle["sessions"][string]["events"],
  settled: ProjectionInterval[],
): FlowConversationTrace {
  const settledEnd = settled.reduce((end, interval) => Math.max(end, interval.eventEndSeq), 0);
  const pending = events.filter((event) => event.seq > settledEnd);
  return {
    sessionId,
    messageStart: 0,
    messageEnd: -1,
    eventStartSeq: pending[0]?.seq ?? settledEnd + 1,
    eventEndSeq: pending.at(-1)?.seq ?? settledEnd,
  };
}

function hasUnrecordedCurrentAttempt(bundle: LoadedRunBundle): boolean {
  return (
    bundle.run.currentAttemptId != null &&
    bundle.run.currentNode != null &&
    bundle.run.currentNodeType === "acp" &&
    !bundle.steps.some((step) => step.attemptId === bundle.run.currentAttemptId)
  );
}

function createCurrentStep(
  bundle: LoadedRunBundle,
  current: CurrentSessionProjection | undefined,
): FlowStepRecord {
  const session = current ? bundle.sessions[current.sessionId] : undefined;
  const prompt =
    current && session ? promptInInterval(session.events, current.interval) : undefined;
  return {
    attemptId: bundle.run.currentAttemptId!,
    nodeId: bundle.run.currentNode!,
    nodeType: "acp",
    outcome: "ok",
    startedAt: bundle.run.currentNodeStartedAt ?? bundle.run.updatedAt,
    finishedAt: bundle.run.updatedAt,
    promptText: prompt ? promptToDisplayText(prompt.prompt) : null,
    rawText: null,
    output: null,
    session: session?.binding ?? null,
    agent: session
      ? {
          agentName: session.binding.agentName,
          agentCommand: session.binding.agentCommand,
          cwd: session.binding.cwd,
        }
      : null,
    ...(current
      ? {
          trace: {
            sessionId: current.sessionId,
            conversation: projectConversationRange(current.projection, current.interval),
          },
        }
      : {}),
  };
}

function resolveCurrentSessionId(bundle: LoadedRunBundle): string | null {
  const attemptId = bundle.run.currentAttemptId;
  for (let index = bundle.trace.length - 1; index >= 0; index -= 1) {
    const event = bundle.trace[index];
    if (event?.attemptId !== attemptId) {
      continue;
    }
    if (typeof event.sessionId === "string" && event.sessionId.length > 0) {
      return event.sessionId;
    }
    const sessionId = event.payload?.sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return sessionId;
    }
  }
  const sessions = Object.values(bundle.sessions);
  return sessions.length === 1 ? sessions[0].id : null;
}
