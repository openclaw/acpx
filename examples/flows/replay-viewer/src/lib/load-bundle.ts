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
  const manifest = await readJson<FlowRunManifest>(reader, "manifest.json");
  const [flow, run, live, steps, trace] = await Promise.all([
    readJson<FlowDefinitionSnapshot>(reader, manifest.paths.flow),
    readJson<FlowRunState>(reader, manifest.paths.runProjection),
    readJson<Partial<FlowRunState>>(reader, manifest.paths.liveProjection).catch(() => null),
    readJson<FlowStepRecord[]>(reader, manifest.paths.stepsProjection),
    readNdjson<FlowTraceEvent>(reader, manifest.paths.trace),
  ]);

  const sessions = Object.fromEntries(
    await Promise.all(
      manifest.sessions.map(async (sessionEntry) => {
        const [binding, record, events] = await Promise.all([
          readJson<FlowSessionBinding>(reader, sessionEntry.bindingPath),
          readJson<SessionRecord>(reader, sessionEntry.recordPath),
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
    steps,
    trace: trace.toSorted((left, right) => left.seq - right.seq),
    sessions,
  };
}

async function readJson<T>(reader: BundleReader, relativePath: string): Promise<T> {
  return JSON.parse(await reader.readText(relativePath)) as T;
}

async function readNdjson<T>(reader: BundleReader, relativePath: string): Promise<T[]> {
  const text = await reader.readText(relativePath);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
