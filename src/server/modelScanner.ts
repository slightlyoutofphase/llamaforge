/**
 * @packageDocumentation
 * Scans directories for GGUF models and extracts their metadata.
 * Handles recursive filesystem walking and mmproj (vision/audio) model matching.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GgufDisplayMetadata, ModelEntry } from "../shared/types";
import * as ggufReader from "./ggufReader";
import { logError, logInfo, logWarn } from "./logger";
import { cachedGgufMetadata, setCachedGgufMetadata } from "./persistence/chatRepo";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "venv", "target"]);
const DEFAULT_SCAN_MAX_DEPTH = 20;
const DEFAULT_SCAN_MAX_ENTRIES = 10000;
const IGNORED_COMPANION_TOKENS = new Set(["model", "mmproj", "mmproject", "projector", "clip"]);
const IGNORED_DRAFT_TOKENS = new Set(["assistant", "eagle3", "draft", "speculative"]);
const QUANTIZATION_TOKEN_PATTERN =
  /^(?:q\d.*|iq\d.*|f16|f32|bf16|fp16|fp32|int\d+|mxfp4|k|m|s|l|xl)$/i;

/**
 * Reads a filesystem error code from an unknown thrown value.
 *
 * @param err - Caught error candidate.
 * @returns The `code` string when present.
 */
function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

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
 * Builds a companion key for draft-model pairing, ignoring draft-role filename tokens.
 *
 * @param filePath - Absolute path to a primary or draft GGUF file.
 * @returns A normalized token key derived from the filename.
 */
function buildDraftCompanionKey(filePath: string): string {
  return path
    .parse(filePath)
    .name.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .filter((token) => !IGNORED_COMPANION_TOKENS.has(token))
    .filter((token) => !IGNORED_DRAFT_TOKENS.has(token))
    .filter((token) => !QUANTIZATION_TOKEN_PATTERN.test(token))
    .join("-");
}

/**
 * Returns whether two companion keys refer to the same model family.
 *
 * @param primaryKey - Key derived from the primary GGUF filename.
 * @param candidateKey - Key derived from a companion filename.
 * @returns `true` when the keys are equal or one contains the other.
 */
function companionKeysAlign(primaryKey: string, candidateKey: string): boolean {
  if (!primaryKey || !candidateKey) return false;
  return (
    primaryKey === candidateKey ||
    primaryKey.includes(candidateKey) ||
    candidateKey.includes(primaryKey)
  );
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
  const primaryKey = buildDraftCompanionKey(primaryPath);
  if (!primaryKey) {
    return undefined;
  }

  const sameDirMatches = draftModels.filter(
    (candidate) =>
      path.dirname(candidate) === path.dirname(primaryPath) &&
      companionKeysAlign(primaryKey, buildDraftCompanionKey(candidate)),
  );
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
 * Stats an mmproj companion so its path and mtime can participate in the metadata cache key.
 *
 * @param mmProjPath - Absolute companion path, if any.
 * @returns Companion identity, or `null` when the file is missing or unreadable.
 */
async function statMmprojCompanion(
  mmProjPath: string | undefined,
): Promise<{ path: string; mtime: number } | null> {
  if (!mmProjPath) return null;
  try {
    const stat = await fs.stat(mmProjPath);
    return { path: mmProjPath, mtime: stat.mtimeMs };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`Unable to stat MMPROJ companion ${mmProjPath}: ${message}`);
    return null;
  }
}

/**
 * Copies vision/audio encoder flags from a companion mmproj into primary-model metadata.
 *
 * Primary GGUFs do not carry `clip.has_vision_encoder`; those keys live on the mmproj.
 *
 * @param metadata - Metadata parsed from the primary GGUF (mutated in place).
 * @param mmProjPath - Absolute path to the matched mmproj, if any.
 * @returns The same metadata object with encoder flags merged when the companion parses.
 */
async function mergeMmprojEncoderFlags(
  metadata: GgufDisplayMetadata,
  mmProjPath: string | undefined,
): Promise<GgufDisplayMetadata> {
  if (!mmProjPath) return metadata;
  try {
    const mmProjMetadata = await ggufReader.parseGgufMetadata(mmProjPath);
    metadata.hasVisionEncoder = Boolean(mmProjMetadata.hasVisionEncoder);
    metadata.hasAudioEncoder = Boolean(mmProjMetadata.hasAudioEncoder);
  } catch (mmErr: unknown) {
    const message = mmErr instanceof Error ? mmErr.message : String(mmErr);
    logWarn(`Failed to parse MMPROJ metadata for ${mmProjPath}: ${message}`);
  }
  return metadata;
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
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      logWarn(
        `Skipping inaccessible path ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      } catch (err: unknown) {
        logWarn(
          `Failed to detect draft model for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
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

      try {
        const stat = await fs.stat(primaryPath);
        const companion = await statMmprojCompanion(mmProjPath);
        let metadata = await cachedGgufMetadata(primaryPath, stat.mtimeMs, {
          mmprojPath: companion?.path ?? "",
          mmprojMtime: companion?.mtime ?? 0,
        });
        if (!metadata) {
          metadata = await cachedGgufMetadata(primaryPath, stat.mtimeMs);
          if (!metadata) {
            metadata = await ggufReader.parseGgufMetadata(primaryPath);
            metadata.fileSizeBytes = stat.size;
            metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);
          }
          await mergeMmprojEncoderFlags(metadata, mmProjPath);
          await setCachedGgufMetadata(primaryPath, stat.mtimeMs, metadata, {
            mmprojPath: companion?.path ?? "",
            mmprojMtime: companion?.mtime ?? 0,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`Failed to merge MMPROJ metadata for ${primaryPath}: ${message}`);
      }

      entries.push({
        publisher,
        modelName,
        primaryPath,
        mmProjPath,
        draftModelPath,
      });
    }
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
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
    const companion = await statMmprojCompanion(entry.mmProjPath);

    let metadata = await cachedGgufMetadata(entry.primaryPath, mtime, {
      mmprojPath: companion?.path ?? "",
      mmprojMtime: companion?.mtime ?? 0,
    });
    if (!metadata) {
      try {
        metadata = await cachedGgufMetadata(entry.primaryPath, mtime);
        if (!metadata) {
          metadata = await ggufReader.parseGgufMetadata(entry.primaryPath);
          metadata.fileSizeBytes = stat.size;
          metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);
        }

        await mergeMmprojEncoderFlags(metadata, entry.mmProjPath);
        await setCachedGgufMetadata(entry.primaryPath, mtime, metadata, {
          mmprojPath: companion?.path ?? "",
          mmprojMtime: companion?.mtime ?? 0,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`Failed to parse GGUF metadata for ${entry.primaryPath}: ${message}`);
      }
    } else if (typeof metadata.isDraftModel === "undefined") {
      metadata.isDraftModel = isDraftModelArchitecture(metadata.architecture);
      await setCachedGgufMetadata(entry.primaryPath, mtime, metadata, {
        mmprojPath: companion?.path ?? "",
        mmprojMtime: companion?.mtime ?? 0,
      });
    }

    return metadata ? { ...entry, metadata } : entry;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`Unable to populate metadata for ${entry.primaryPath}: ${message}`);
    return entry;
  }
}
