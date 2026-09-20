import type { AcpClient } from "../../acp/client.js";
import type { AcpControlAuthority } from "../../async-control.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import { connectAndLoadSession } from "../../runtime/engine/reconnect.js";
import type { SessionRecord } from "../../types.js";
import { applyConfigOptionSelection, applyModelSelection } from "../config-options.js";
import { recordSessionUpdate } from "../conversation-model.js";
import { setDesiredModeId } from "../mode-preference.js";
import { advertisedModelState } from "../model-state.js";
import { isoNow, resolveSessionRecord, writeSessionRecord } from "../persistence.js";
import {
  QueueControlDeadline,
  type QueueOwnerControlMethods,
  type IdleControlOptions,
} from "../queue/control-admission.js";
import { acquireSessionTurn } from "../turn-ownership.js";

type OwnedControlOptions = {
  client: AcpClient;
  record: SessionRecord;
  sessionId: () => string;
  checkpoint: () => Promise<void>;
  retire: () => Promise<void>;
};

async function acceptControl<T>(
  options: OwnedControlOptions,
  invoke: (authority: AcpControlAuthority) => Promise<T>,
  apply: (response: T) => void,
  deadline = new QueueControlDeadline(),
): Promise<T> {
  deadline.assertActive();
  const raw = invoke(deadline.authority).then(
    async (response) => {
      deadline.responseSettled();
      apply(response);
      await options.checkpoint();
      return response;
    },
    (error: unknown) => {
      deadline.responseSettled();
      throw error;
    },
  );
  try {
    return await deadline.wait(raw);
  } catch (error) {
    if (deadline.isExpired(error) && deadline.nativeAdmitted) {
      // Retirement must begin before waiting for a stalled native request.
      const [retired] = await Promise.allSettled([options.retire(), raw]);
      if (retired.status === "rejected") {
        throw retired.reason;
      }
    }
    throw error;
  }
}

export function createOwnedSessionControls(options: OwnedControlOptions): QueueOwnerControlMethods {
  return {
    setSessionMode: async (modeId, deadline) => {
      await acceptControl(
        options,
        (authority) => options.client.setSessionMode(options.sessionId(), modeId, authority),
        () => setDesiredModeId(options.record, modeId),
        deadline,
      );
    },
    setSessionModel: async (modelId, deadline) => {
      const models = advertisedModelState(options.record.acpx);
      return await acceptControl(
        options,
        (authority) =>
          options.client.setSessionModel(options.sessionId(), modelId, models, authority),
        (response) => {
          options.record.acpx = applyModelSelection(options.record.acpx, modelId, response);
        },
        deadline,
      );
    },
    setSessionConfigOption: async (configId, value, deadline) => {
      const models = advertisedModelState(options.record.acpx);
      return await acceptControl(
        options,
        (authority) =>
          options.client.setSessionConfigOption(
            options.sessionId(),
            configId,
            value,
            models,
            authority,
          ),
        (response) => {
          options.record.acpx = applyConfigOptionSelection(
            options.record.acpx,
            configId,
            value,
            response,
            models?.configId,
          );
        },
        deadline,
      );
    },
  };
}

type IdleOwnerControlOptions = IdleControlOptions & {
  client: AcpClient;
  sessionId: string;
  verbose?: boolean;
  onRetirementFailure: () => void;
};

type ControlInvocation<T> = (
  controls: QueueOwnerControlMethods,
  deadline: QueueControlDeadline,
) => Promise<T>;

async function runIdleControlWithRecord<T>(
  options: IdleOwnerControlOptions,
  record: SessionRecord,
  invoke: ControlInvocation<T>,
): Promise<T> {
  const { client, deadline } = options;
  deadline.assertActive();
  let retirement: Promise<void> | undefined;
  const retire = () => {
    retirement ??= client.close().catch((error: unknown) => {
      options.onRetirementFailure();
      throw error;
    });
    return retirement;
  };
  const onAbort = () => {
    void retire().catch(() => {});
  };
  const checkpoint = async () => {
    record.lastUsedAt = isoNow();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  };
  let sessionId = record.acpSessionId;
  const controls = createOwnedSessionControls({
    client,
    record,
    sessionId: () => sessionId,
    checkpoint,
    retire,
  });
  client.setEventHandlers({
    onSessionUpdate: (notification) => {
      record.acpx = recordSessionUpdate(record, record.acpx, notification);
    },
  });
  deadline.timeoutSignal.addEventListener("abort", onAbort, { once: true });
  let connected = false;
  let completed = false;
  try {
    await connectAndLoadSession({
      client,
      record,
      resumePolicy: "same-session-only",
      replacingConfigOption: options.replacingConfigOption,
      timeoutMs: deadline.remainingMs,
      authority: deadline.authority,
      verbose: options.verbose,
      activeController: {
        ...controls,
        hasActivePrompt: () => client.hasActivePrompt(),
        requestCancelActivePrompt: () => client.requestCancelActivePrompt(),
      },
      onSessionIdResolved: (value) => {
        sessionId = value;
      },
    });
    connected = true;
    deadline.assertActive();
    const value = await invoke(controls, deadline);
    completed = true;
    return value;
  } finally {
    deadline.timeoutSignal.removeEventListener("abort", onAbort);
    try {
      if (!connected) {
        await retire();
      }
      await retirement;
      if (!completed || retirement) {
        await checkpoint().catch(() => {
          // The operation retains its original failure; preserve accepted replay when possible.
        });
      }
    } finally {
      client.clearEventHandlers();
    }
  }
}

export async function runIdleOwnerControl<T>(
  options: IdleOwnerControlOptions,
  invoke: ControlInvocation<T>,
): Promise<T> {
  const { acpxRecordId } = await resolveSessionRecord(options.sessionId);
  const ownership = await acquireSessionTurn(acpxRecordId, options.deadline.signal).catch(
    (error: unknown) => {
      options.deadline.assertActive();
      throw error;
    },
  );
  try {
    return await runIdleControlWithRecord(
      options,
      await resolveSessionRecord(acpxRecordId),
      invoke,
    );
  } finally {
    await ownership[Symbol.asyncDispose]();
  }
}
