/**
 * @packageDocumentation
 * Scans directories for GGUF models and extracts their metadata.
 * Handles recursive filesystem walking and mmproj (vision/audio) model matching.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelEntry } from "../shared/types";
import * as ggufReader from "./ggufReader";
import { logError, logInfo, logWarn } from "./logger";
import { cachedGgufMetadata, setCachedGgufMetadata } from "./persistence/chatRepo";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "venv", "target"]);
const DEFAULT_SCAN_MAX_DEPTH = 20;
const DEFAULT_SCAN_MAX_ENTRIES = 10000;
const IGNORED_COMPANION_TOKENS = new Set(["model", "mmproj", "mmproject", "projector", "clip"]);
const QUANTIZATION_TOKEN_PATTERN =
  /^(?:q\d(?:_\d)?|iq\d.*|f16|f32|bf16|fp16|fp32|int\d+|mxfp4|qwen|k|m|s|l|xl)$/i;

/**
 * Determines whether a GGUF architecture string indicates a draft/assistant model
 * for speculative decoding.
 *
 * @param architecture - The architecture string from GGUF metadata.
 * @returns `true` if the model is a draft model (assistant or eagle3 architecture).
 */
function isDraftModelArchitecture(architecture: string): boolean {
  const lower = architecture.toLowerCase();
  return lower.includes("assistant") || lower.includes("eagle3");
}

/**
 * Builds a normalized token key used to match main GGUF files with mmproj companions.
 *
 * @param filePath - Absolute path to a GGUF or mmproj file.
 * @returns A normalized token key derived from the filename.
 */
function buildCompanionKey(filePath: string): string {
  return path
    .parse(filePath)
    .name.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .filter((token) => !IGNORED_COMPANION_TOKENS.has(token))
    .filter((token) => !QUANTIZATION_TOKEN_PATTERN.test(token))
    .join("-");
}

/**
 * Finds the best mmproj companion file for a primary GGUF model.
 *
 * @param primaryPath - Absolute path to the primary model file.
 * @param mmprojFiles - Candidate multimodal projection files discovered during the scan.
 * @returns The matching mmproj file path, or `undefined` when no unique match exists.
 */
function findMatchingMmproj(primaryPath: string, mmprojFiles: string[]): string | undefined {
  const primaryKey = buildCompanionKey(primaryPath);
  if (!primaryKey) {
    return undefined;
  }

  const sameDirMatches = mmprojFiles.filter(
    (candidate) =>
      path.dirname(candidate) === path.dirname(primaryPath) &&
      buildCompanionKey(candidate) === primaryKey,
  );
  if (sameDirMatches.length === 1) {
    return sameDirMatches[0];
  }
  if (sameDirMatches.length > 1) {
    logWarn(
      `Ambiguous mmproj companions for ${primaryPath}: ${sameDirMatches.join(", ")}. Leaving mmProjPath unset.`,
    );
    return undefined;
  }

  const globalMatches = mmprojFiles.filter(
    (candidate) => buildCompanionKey(candidate) === primaryKey,
  );
  if (globalMatches.length === 1) {
    return globalMatches[0];
  }
  if (globalMatches.length > 1) {
    logWarn(
      `Ambiguous mmproj companions for ${primaryPath}: ${globalMatches.join(", ")}. Leaving mmProjPath unset.`,
    );
  }

  return undefined;
}

/**
 * Finds the best draft model companion for a primary GGUF model.
 * Only considers draft models in the same directory as the primary model.
 *
 * @param primaryPath - Absolute path to the primary model file.
 * @param draftModels - Candidate draft model paths discovered during the scan.
 * @returns The matching draft model file path, or `undefined` when no unique match exists.
 */
function findMatchingDraftModel(primaryPath: string, draftModels: string[]): string | undefined {
  const primaryDir = path.dirname(primaryPath);

  const sameDirMatches = draftModels.filter((candidate) => path.dirname(candidate) === primaryDir);
  if (sameDirMatches.length === 1) {
    return sameDirMatches[0];
  }
  if (sameDirMatches.length > 1) {
    logWarn(
      `Ambiguous draft models for ${primaryPath}: ${sameDirMatches.join(", ")}. Leaving draftModelPath unset.`,
    );
  }

  return undefined;
}

/**
 * Options controlling recursive model scan execution.
 */
export interface ScanOptions {
  /** Maximum directory recursion depth for the model scan. */
  maxDepth?: number;
  /** Maximum number of files to inspect while scanning for models. */
  maxEntries?: number;
}

/**
 * Recursively walks a directory to find GGUF and multimodal projection files.
 *
 * @param dir - Directory to scan.
 * @param depth - Current recursion depth.
 * @param state - Mutable traversal state tracking how many entries have been inspected.
 * @param options - Effective scan limits controlling recursion depth and entry count.
 * @returns Absolute file paths for candidate GGUF and mmproj files.
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
      state.count++;
      if (state.count > options.maxEntries) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkDir(res, depth + 1, state, options)));
      } else {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".gguf") || lower.includes("mmproj")) {
          files.push(res);
        }
      }
    }
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "EACCES") {
      logWarn(`Skipping inaccessible path ${dir}: ${err.message}`);
    } else {
      logError(`Error walking directory ${dir}:`, err);
    }
  }
  return files;
}

/**
 * Scans the provided directory path for models, partitioned by publisher and model name.
 *
 * @param rootPath - Absolute path to the models directory.
 * @param options - Optional overrides for recursion depth and scan entry limits.
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
  const env = process.env as NodeJS.ProcessEnv & {
    MODEL_SCAN_MAX_DEPTH?: string;
    MODEL_SCAN_MAX_ENTRIES?: string;
  };
  const envMaxDepth = Number(env.MODEL_SCAN_MAX_DEPTH);
  const envMaxEntries = Number(env.MODEL_SCAN_MAX_ENTRIES);
  const resolvedOptions: Required<ScanOptions> = {
    maxDepth: options.maxDepth ?? (envMaxDepth || DEFAULT_SCAN_MAX_DEPTH),
    maxEntries: options.maxEntries ?? (envMaxEntries || DEFAULT_SCAN_MAX_ENTRIES),
  };

  logInfo(`Scanning models at: ${rootPath}`);
  logInfo(`Scan options: depth=${resolvedOptions.maxDepth} entries=${resolvedOptions.maxEntries}`);

  try {
    const stats = await fs.stat(rootPath);
    if (!stats.isDirectory()) {
      logWarn(`Models path ${rootPath} is not a directory. Skipping scan.`);
      return [];
    }

    const allGgufFiles = await walkDir(rootPath, 0, { count: 0 }, resolvedOptions);
    const mmprojFiles = allGgufFiles.filter((f) =>
      path.basename(f).toUpperCase().includes("MMPROJ"),
    );
    const primaryGgufs = allGgufFiles.filter(
      (f) => !path.basename(f).toUpperCase().includes("MMPROJ"),
    );

    // Detect draft models by parsing GGUF metadata (architecture contains "assistant" or "eagle3")
    const draftModelPaths = new Set<string>();
    for (const filePath of primaryGgufs) {
      try {
        const stat = await fs.stat(filePath);
        let metadata = await cachedGgufMetadata(filePath, stat.mtimeMs);
        if (!metadata) {
          metadata = await ggufReader.parseGgufMetadata(filePath);
          metadata.fileSizeBytes = stat.size;
          metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);
          await setCachedGgufMetadata(filePath, stat.mtimeMs, metadata);
        } else if (typeof metadata.isDraftModel === "undefined") {
          metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);
          await setCachedGgufMetadata(filePath, stat.mtimeMs, metadata);
        }
        if (metadata.isDraftModel) {
          draftModelPaths.add(filePath);
        }
      } catch (err: any) {
        logWarn(`Failed to detect draft model for ${filePath}: ${err?.message || String(err)}`);
      }
    }

    const mainModels = primaryGgufs.filter((f) => !draftModelPaths.has(f));

    for (const primaryPath of mainModels) {
      const relPath = path.relative(rootPath, primaryPath);
      const pathParts = relPath.split(path.sep);

      let publisher = "Unknown";
      let modelName = path.basename(primaryPath, ".gguf");

      if (pathParts.length >= 3) {
        // format: publisher/model/file.gguf
        publisher = pathParts[0] || publisher;
        modelName = pathParts[1] || modelName;
      } else if (pathParts.length === 2) {
        // format: model/file.gguf
        modelName = pathParts[0] || modelName;
      }

      const mmProjPath = findMatchingMmproj(primaryPath, mmprojFiles);
      const draftModelPath = findMatchingDraftModel(primaryPath, [...draftModelPaths]);

      entries.push({
        publisher,
        modelName,
        primaryPath,
        mmProjPath,
        draftModelPath,
      });
    }
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      logWarn(`Models path ${rootPath} does not exist or is not accessible. Skipping scan.`);
    } else {
      logError(`Critical error scanning models at ${rootPath}:`, err);
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
        metadata = await ggufReader.parseGgufMetadata(entry.primaryPath);
        metadata.fileSizeBytes = stat.size;
        metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);

        if (entry.mmProjPath) {
          try {
            const mmProjMetadata = await ggufReader.parseGgufMetadata(entry.mmProjPath);
            metadata.hasVisionEncoder = mmProjMetadata.hasVisionEncoder;
            metadata.hasAudioEncoder = mmProjMetadata.hasAudioEncoder;
          } catch (mmErr: any) {
            logWarn(
              `Failed to parse MMPROJ metadata for ${entry.mmProjPath}: ${mmErr?.message || String(mmErr)}`,
            );
          }
        }

        await setCachedGgufMetadata(entry.primaryPath, mtime, metadata);
      } catch (err: any) {
        logWarn(
          `Failed to parse GGUF metadata for ${entry.primaryPath}: ${err?.message || String(err)}`,
        );
      }
    } else if (typeof metadata.isDraftModel === "undefined") {
      metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);
      await setCachedGgufMetadata(entry.primaryPath, mtime, metadata);
    }

    return metadata ? { ...entry, metadata } : entry;
  } catch (err: any) {
    logWarn(`Unable to populate metadata for ${entry.primaryPath}: ${err?.message || String(err)}`);
    return entry;
  }
}
