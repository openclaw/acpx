import type { FlowRunManifest, RunBundleSummary } from "../types";

export type BundleReader = {
  sourceType: "sample" | "local" | "recent";
  label: string;
  readText(relativePath: string): Promise<string>;
  readJson<T>(relativePath: string): Promise<T>;
};

type RunsIndexResponse = {
  runs: RunBundleSummary[];
};

export function createSampleBundleReader(basePath: string = "/sample-run"): BundleReader {
  const normalizedBase = basePath.replace(/\/+$/, "");

  async function readText(relativePath: string): Promise<string> {
    const response = await fetch(`${normalizedBase}/${relativePath}`);
    if (!response.ok) {
      throw new Error(`Failed to read ${relativePath}: ${response.status}`);
    }
    return response.text();
  }

  return {
    sourceType: "sample",
    label: "Bundled sample run",
    readText,
    async readJson<T>(relativePath: string): Promise<T> {
      const text = await readText(relativePath);
      return JSON.parse(text) as T;
    },
  };
}

export function createRecentRunBundleReader(run: RunBundleSummary): BundleReader {
  const basePath = `/api/runs/${encodeURIComponent(run.runId)}/files`;

  async function readText(relativePath: string): Promise<string> {
    const response = await fetch(
      `${basePath}/${relativePath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to read ${relativePath}: ${response.status}`);
    }
    return response.text();
  }

  return {
    sourceType: "recent",
    label: `Recent run: ${run.runId}`,
    readText,
    async readJson<T>(relativePath: string): Promise<T> {
      const text = await readText(relativePath);
      return JSON.parse(text) as T;
    },
  };
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function createDirectoryBundleReader(): Promise<BundleReader> {
  const pickerWindow = window as unknown as Window & {
    showDirectoryPicker(options: {
      mode: "read";
      startIn: "documents";
    }): Promise<FileSystemDirectoryHandle>;
  };
  const directoryHandle = await pickerWindow.showDirectoryPicker({
    mode: "read",
    startIn: "documents",
  });

  async function readText(relativePath: string): Promise<string> {
    const file = await resolveFile(directoryHandle, relativePath);
    return file.text();
  }

  return {
    sourceType: "local",
    label: directoryHandle.name,
    readText,
    async readJson<T>(relativePath: string): Promise<T> {
      const text = await readText(relativePath);
      return JSON.parse(text) as T;
    },
  };
}

async function resolveFile(root: FileSystemDirectoryHandle, relativePath: string): Promise<File> {
  const parts = relativePath.split("/").filter(Boolean);
  let current = root;

  for (const segment of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment);
  }

  const fileHandle = await current.getFileHandle(parts.at(-1) ?? "");
  return fileHandle.getFile();
}

export async function readManifest(reader: BundleReader): Promise<FlowRunManifest> {
  return reader.readJson<FlowRunManifest>("manifest.json");
}

export async function listRecentRuns(): Promise<RunBundleSummary[] | null> {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as RunsIndexResponse;
    return payload.runs;
  } catch {
    return null;
  }
}
