import type {
  ClientSideConnection,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  Stream,
} from "@agentclientprotocol/sdk";

type Message = Stream["writable"] extends WritableStream<infer Value> ? Value : never;

export type PromptObservation = {
  sessionId: unknown;
  start?: number;
  end?: number;
  ambiguous: boolean;
};

export type ObservedPrompt = {
  pending: Promise<PromptResponse>;
  observation: PromptObservation;
};

export class PromptObservations {
  private readonly requests = new WeakMap<object, PromptObservation>();
  private readonly active = new Set<PromptObservation>();
  private bindingFailed = false;

  constructor(private readonly updates: SessionNotification[]) {}

  observeStream(stream: Stream): Stream {
    const writer = stream.writable.getWriter();
    return {
      readable: stream.readable,
      writable: new WritableStream<Message>({
        write: (message) => {
          if ("method" in message && message.method === "session/prompt") {
            this.handoff(message.params);
          }
          return writer.write(message);
        },
        close: () => writer.close(),
        abort: (reason: unknown) => writer.abort(reason),
      }),
    };
  }

  dispatch(
    connection: Pick<ClientSideConnection, "prompt">,
    params: PromptRequest,
  ): ObservedPrompt {
    const observation: PromptObservation = { sessionId: params.sessionId, ambiguous: false };
    this.requests.set(params, observation);
    const finish = () => {
      observation.end = this.updates.length;
      this.active.delete(observation);
    };
    let pending: Promise<PromptResponse>;
    try {
      pending = connection.prompt(params);
    } catch (error) {
      finish();
      throw error;
    }
    // Observe the original Promise before expectation/timeout wrappers or a later await.
    void pending.then(finish, finish);
    return { pending, observation };
  }

  count(source: PromptObservation | undefined, name: string): number {
    const label = JSON.stringify(name);
    if (!source) {
      throw new Error(`Unknown prompt update source ${label}`);
    }
    if (this.bindingFailed) {
      throw new Error(`Cannot correlate outgoing prompt updates for ${label}`);
    }
    if (typeof source.sessionId !== "string" || source.sessionId.length === 0) {
      throw new Error(`Prompt update source ${label} has no valid session`);
    }
    if (source.start === undefined) {
      throw new Error(`Prompt update source ${label} has no observed handoff`);
    }
    if (source.end === undefined) {
      throw new Error(`Prompt update source ${label} is still unsettled`);
    }
    if (source.ambiguous) {
      throw new Error(
        `Prompt update source ${label} is ambiguous: overlapping prompts in one session`,
      );
    }
    return this.updates
      .slice(source.start, source.end)
      .filter((update) => update.sessionId === source.sessionId).length;
  }

  private handoff(params: unknown): void {
    if (params === null || typeof params !== "object") {
      this.bindingFailed = true;
      return;
    }
    const observation = this.requests.get(params);
    if (!observation || observation.start !== undefined || observation.end !== undefined) {
      this.bindingFailed = true;
      return;
    }
    // Bind the original params object; equal payloads can belong to different prompts.
    observation.start = this.updates.length;
    for (const other of this.active) {
      if (other.sessionId === observation.sessionId) {
        other.ambiguous = true;
        observation.ambiguous = true;
      }
    }
    this.active.add(observation);
  }
}
