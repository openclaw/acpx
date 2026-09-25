import type { Dimensions } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildGraphLayout } from "../lib/view-model.js";
import type { ViewerGraphLayout } from "../lib/view-model.js";
import type { LoadedRunBundle } from "../types.js";

export function useGraphLayout(bundle: LoadedRunBundle | null) {
  const runId = bundle?.run.runId ?? null;
  const currentRun = useRef(runId);
  const [measurements, setMeasurements] = useState<{
    runId: string;
    dimensions: ReadonlyMap<string, Dimensions>;
  } | null>(null);
  const [result, setResult] = useState<{
    runId: string;
    inputKey: string;
    layout: ViewerGraphLayout | null;
  } | null>(null);
  const onMeasurements = useCallback(
    (measuredRunId: string, dimensions: ReadonlyMap<string, Dimensions>) => {
      if (measuredRunId !== currentRun.current) {
        return;
      }
      setMeasurements((current) =>
        current?.runId === measuredRunId && current.dimensions === dimensions
          ? current
          : { runId: measuredRunId, dimensions },
      );
    },
    [],
  );
  const dimensions = measurements?.runId === runId ? measurements.dimensions : null;
  const inputKey = bundle && dimensions ? measuredLayoutKey(bundle, dimensions) : null;
  const currentInput = useRef(inputKey);
  useLayoutEffect(() => {
    currentRun.current = runId;
    currentInput.current = inputKey;
  }, [runId, inputKey]);

  useEffect(() => {
    if (!bundle || !dimensions || inputKey === null) {
      return undefined;
    }
    let cancelled = false;
    void buildGraphLayout(bundle.flow, dimensions).then((layout) => {
      if (cancelled || currentInput.current !== inputKey) {
        return;
      }
      setResult({ runId: bundle.run.runId, inputKey, layout });
    });

    return () => {
      cancelled = true;
    };
    // The definition is immutable per run; only its measured rectangles change layout.
  }, [inputKey]);

  return {
    layout: result?.runId === runId ? result.layout : null,
    routesReady: inputKey !== null && result?.inputKey === inputKey,
    onMeasurements,
  };
}

function measuredLayoutKey(
  bundle: LoadedRunBundle,
  measurements: ReadonlyMap<string, Dimensions>,
): string | null {
  const dimensions: Array<[string, number, number]> = [];
  for (const id of Object.keys(bundle.flow.nodes).toSorted()) {
    const size = measurements.get(id);
    if (
      !size ||
      !Number.isFinite(size.width) ||
      size.width <= 0 ||
      !Number.isFinite(size.height) ||
      size.height <= 0
    ) {
      return null;
    }
    dimensions.push([id, size.width, size.height]);
  }
  return JSON.stringify([bundle.run.runId, dimensions]);
}
