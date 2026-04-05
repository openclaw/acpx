import type { QueueOwnerActiveSessionController } from "../queue-owner-turn-controller.js";
import {
  connectAndLoadSession as connectAndLoadSharedSession,
  type ConnectAndLoadSessionResult,
  type ConnectedSessionController,
} from "../runtime-core/reconnect.js";

export type ConnectAndLoadSessionOptions = Omit<
  Parameters<typeof connectAndLoadSharedSession>[0],
  "activeController" | "onClientAvailable"
> & {
  activeController: QueueOwnerActiveSessionController;
  onClientAvailable?: (controller: QueueOwnerActiveSessionController) => void;
};

export { type ConnectAndLoadSessionResult };

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  return await connectAndLoadSharedSession({
    ...options,
    activeController: options.activeController as ConnectedSessionController,
    onClientAvailable: options.onClientAvailable
      ? (controller) => {
          options.onClientAvailable?.(controller as QueueOwnerActiveSessionController);
        }
      : undefined,
  });
}
