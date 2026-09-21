import type { SessionRecord } from "../../types.js";
import type { AcpRuntimeCapabilities } from "../public/contract.js";
import { AcpRuntimeError } from "../public/errors.js";

export function advertisedConfigOptionIds(
  record: SessionRecord | undefined,
): Set<string> | undefined {
  const configOptions = record?.acpx?.config_options;
  if (!configOptions) {
    return undefined;
  }

  return new Set(
    configOptions
      .map((option) => option.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
  );
}

/** Caller-owned controls and the config option keys the session last advertised. */
export function capabilitiesFromRecord(record: SessionRecord | undefined): AcpRuntimeCapabilities {
  const advertisedIds = advertisedConfigOptionIds(record);
  return {
    controls: [
      "session/set_mode",
      "session/set_model",
      "session/set_config_option",
      "session/status",
    ],
    ...(advertisedIds?.size ? { configOptionKeys: [...advertisedIds] } : {}),
  };
}

export function resolveSupportedConfigOptionId(record: SessionRecord, configId: string): string {
  const advertisedIds = advertisedConfigOptionIds(record);
  if (!advertisedIds) {
    return configId;
  }

  if (advertisedIds.has(configId)) {
    return configId;
  }

  if (configId === "thinking" && advertisedIds.has("effort")) {
    return "effort";
  }

  const supported = [...advertisedIds].toSorted();
  const supportedText = supported.length > 0 ? supported.join(", ") : "none";
  throw new AcpRuntimeError(
    "ACP_BACKEND_UNSUPPORTED_CONTROL",
    `ACP session ${record.acpxRecordId} does not advertise config option '${configId}'. Supported config options: ${supportedText}.`,
  );
}
