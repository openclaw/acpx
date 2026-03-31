import type {
  FlowBundledSessionEvent,
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowStepRecord,
  FlowTraceEvent,
  LoadedRunBundle,
  SessionRecord,
} from "../types.js";
import type { BundleReader } from "./bundle-reader.js";
import { mergeLiveRunState } from "./run-state.js";

export async function loadRunBundle(reader: BundleReader): Promise<LoadedRunBundle> {
  const manifest = await reader.readJson<FlowRunManifest>("manifest.json");
  const [flow, run, live, steps, trace] = await Promise.all([
    reader.readJson<FlowDefinitionSnapshot>(manifest.paths.flow),
    reader.readJson<FlowRunState>(manifest.paths.runProjection),
    reader.readJson<Partial<FlowRunState>>(manifest.paths.liveProjection).catch(() => null),
    reader.readJson<FlowStepRecord[]>(manifest.paths.stepsProjection),
    readNdjson<FlowTraceEvent>(reader, manifest.paths.trace),
  ]);

  const sessions = Object.fromEntries(
    await Promise.all(
      manifest.sessions.map(async (sessionEntry) => {
        const [binding, record, events] = await Promise.all([
          reader.readJson<FlowSessionBinding>(sessionEntry.bindingPath),
          reader.readJson<SessionRecord>(sessionEntry.recordPath),
          readNdjson<FlowBundledSessionEvent>(reader, sessionEntry.eventsPath),
        ]);

        return [
          sessionEntry.id,
          {
            id: sessionEntry.id,
            binding,
            record,
            events,
          },
        ] as const;
      }),
    ),
  );

  return {
    sourceType: reader.sourceType,
    sourceLabel: reader.label,
    manifest,
    flow,
    run: mergeLiveRunState(run, live),
    live,
    steps: steps.slice().toSorted(compareByAttemptStart),
    trace: trace.slice().toSorted((left, right) => left.seq - right.seq),
    sessions,
  };
}

async function readNdjson<T>(reader: BundleReader, relativePath: string): Promise<T[]> {
  const text = await reader.readText(relativePath);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function compareByAttemptStart(left: FlowStepRecord, right: FlowStepRecord): number {
  const started = Date.parse(left.startedAt) - Date.parse(right.startedAt);
  if (started !== 0) {
    return started;
  }
  return left.attemptId.localeCompare(right.attemptId);
}
