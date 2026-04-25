/**
 * @packageDocumentation
 * Scans directories for GGUF models and extracts their metadata.
 * Handles recursive filesystem walking and mmproj (vision/audio) model matching.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelEntry } from "@shared/types.js";
import { parseGgufMetadata } from "./ggufReader";
import { cachedGgufMetadata, setCachedGgufMetadata } from "./persistence/chatRepo";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "venv", "target"]);
const DEFAULT_SCAN_MAX_DEPTH = 20;
const DEFAULT_SCAN_MAX_ENTRIES = 10000;

export interface ScanOptions {
  maxDepth?: number;
  maxEntries?: number;
}

/**
 * Recursively walks a directory to find GGUF and multimodal projection files.
 *
 * @param dir - starting directory.
 * @param depth - current recursion depth.
 * @returns list of absolute file paths.
 * @internal
 */
async function walkDir(
  dir: string,
  depth = 0,
  state = { count: 0 },
  options: Required<ScanOptions>,
): Promise<string[]> {
  if (depth > options.maxDepth || state.count >= options.maxEntries) return [];
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (state.count >= options.maxEntries) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkDir(res, depth + 1, state, options)));
      } else {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".gguf") || lower.includes("mmproj")) {
          files.push(res);
          state.count++;
        }
      }
    }
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "EACCES") {
      console.warn(`Skipping inaccessible path ${dir}: ${err.message}`);
    } else {
      console.error(`Error walking directory ${dir}:`, err);
    }
  }
  return files;
}

/**
 * Scans the provided directory path for models, partitioned by publisher and model name.
 *
 * @param rootPath - Absolute path to the models directory.
 * @returns Array of {@link ModelEntry} discovered in the path.
 * @example
 * ```typescript
 * const models = await scanModels("/path/to/models");
 * ```
 */
export async function scanModels(
  rootPath: string,
  options: ScanOptions = {},
): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = [];
  const resolvedOptions: Required<ScanOptions> = {
    maxDepth:
      options.maxDepth ?? (Number(process.env.MODEL_SCAN_MAX_DEPTH) || DEFAULT_SCAN_MAX_DEPTH),
    maxEntries:
      options.maxEntries ??
      (Number(process.env.MODEL_SCAN_MAX_ENTRIES) || DEFAULT_SCAN_MAX_ENTRIES),
  };

  console.log(`Scanning models at: ${rootPath}`);
  console.log(
    `Scan options: depth=${resolvedOptions.maxDepth} entries=${resolvedOptions.maxEntries}`,
  );

  try {
    const stats = await fs.stat(rootPath);
    if (!stats.isDirectory()) {
      console.warn(`Models path ${rootPath} is not a directory. Skipping scan.`);
      return [];
    }

    const allGgufFiles = await walkDir(rootPath, 0, { count: 0 }, resolvedOptions);
    const mmprojFiles = allGgufFiles.filter((f) =>
      path.basename(f).toUpperCase().includes("MMPROJ"),
    );
    const primaryGgufs = allGgufFiles.filter(
      (f) => !path.basename(f).toUpperCase().includes("MMPROJ"),
    );

    for (const primaryPath of primaryGgufs) {
      const relPath = path.relative(rootPath, primaryPath);
      const pathParts = relPath.split(path.sep);

      let publisher = "Unknown";
      let modelName = path.basename(primaryPath, ".gguf");

      if (pathParts.length >= 3) {
        // format: publisher/model/file.gguf
        publisher = pathParts[0];
        modelName = pathParts[1];
      } else if (pathParts.length === 2) {
        // format: model/file.gguf
        modelName = pathParts[0];
      }

      const primaryBase = path.parse(primaryPath).name.toLowerCase();
      const primaryDir = path.dirname(primaryPath);
      let mmProjPath: string | undefined;

      // 1. Try to find matching mmproj by filename prefix in the same or nearby folders
      const matchingMmproj = mmprojFiles.find((mf) =>
        path.parse(mf).name.toLowerCase().startsWith(primaryBase),
      );
      if (matchingMmproj) {
        mmProjPath = matchingMmproj;
      } else {
        // 2. Try to find ANY mmproj in the same directory
        const sameDirMmproj = mmprojFiles.find((mf) => path.dirname(mf) === primaryDir);
        if (sameDirMmproj) {
          mmProjPath = sameDirMmproj;
        }
      }

      entries.push({
        publisher,
        modelName,
        primaryPath,
        mmProjPath,
      });
    }
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      console.warn(`Models path ${rootPath} does not exist or is not accessible. Skipping scan.`);
    } else {
      console.error(`Critical error scanning models at ${rootPath}:`, err);
    }
  }

  return entries;
}

/**
 * Populates a model entry with its parsed GGUF metadata.
 *
 * @param entry - The model entry to populate.
 * @returns The model entry with `metadata` field populated.
 */
export async function populateMetadata(entry: ModelEntry): Promise<ModelEntry> {
  try {
    const stat = await fs.stat(entry.primaryPath);
    const mtime = stat.mtimeMs;

    let metadata = await cachedGgufMetadata(entry.primaryPath, mtime);
    if (!metadata) {
      try {
        metadata = await parseGgufMetadata(entry.primaryPath);
        metadata.fileSizeBytes = stat.size;
        await setCachedGgufMetadata(entry.primaryPath, mtime, metadata);
      } catch (err: any) {
        console.warn(
          `Failed to parse GGUF metadata for ${entry.primaryPath}: ${err?.message || String(err)}`,
        );
      }
    }

    return metadata ? { ...entry, metadata } : entry;
  } catch (err: any) {
    console.warn(
      `Unable to populate metadata for ${entry.primaryPath}: ${err?.message || String(err)}`,
    );
    return entry;
  }
}
