import { useEffect, useState } from "react";
import { buildGraphLayout } from "../lib/view-model.js";
import type { ViewerGraphLayout } from "../lib/view-model.js";
import type { LoadedRunBundle } from "../types.js";

export function useGraphLayout(bundle: LoadedRunBundle | null) {
  const [layout, setLayout] = useState<ViewerGraphLayout | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!bundle) {
      setLayout(null);
      return;
    }

    setLayout(null);

    void buildGraphLayout(bundle.flow).then((nextLayout) => {
      if (cancelled) {
        return;
      }
      setLayout(nextLayout);
    });

    return () => {
      cancelled = true;
    };
  }, [bundle?.run.runId]);

  return layout;
}
