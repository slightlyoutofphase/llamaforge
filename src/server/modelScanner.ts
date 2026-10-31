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
const IGNORED_DRAFT_TOKENS = new Set([
  "assistant",
  "eagle3",
  "dflash",
  "dspark",
  "draft",
  "speculative",
]);
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
 * @returns `true` if the model is a draft model (assistant, DFlash, or Eagle3 architecture).
 */
function isDraftModelArchitecture(architecture: string): boolean {
  const lower = architecture.toLowerCase();
  return lower.includes("assistant") || lower === "eagle3" || lower === "dflash";
}

/**
 * Determines whether a GGUF should be treated as a hidden draft companion rather
 * than a selectable primary model.
 *
 * Classification prefers `general.architecture` (`gemma4-assistant`, `dflash`, `eagle3`, …)
 * and also accepts filename tokens such as `assistant` / `dflash` / `dspark` / `eagle3` / `draft`.
 *
 * @param filePath - Absolute path to the GGUF being classified.
 * @param architecture - Architecture string from GGUF metadata.
 * @returns `true` when the file is a speculative-decoding draft model.
 */
function isDraftModelCandidate(filePath: string, architecture: string): boolean {
  if (isDraftModelArchitecture(architecture)) {
    return true;
  }
  const tokens = path
    .parse(filePath)
    .name.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  return tokens.some((token) => IGNORED_DRAFT_TOKENS.has(token));
}

/**
 * Returns whether a sidecar filename contains a speculative-decoding family word.
 *
 * Matching is a case-insensitive substring of the filename, including the extension.
 *
 * @param filePath - Absolute path to the draft GGUF.
 * @param word - Family word such as `dflash`, `dspark`, or `eagle3`.
 * @returns `true` when the filename contains the word in any casing.
 */
function draftFileNameContains(filePath: string, word: string): boolean {
  return path.basename(filePath).toLowerCase().includes(word.toLowerCase());
}

/**
 * Maps a draft GGUF onto llama-server `--spec-type`.
 *
 * Specialized companions require both a filename family word and the matching
 * `general.architecture` value:
 * - DFlash: filename contains `dflash` and architecture is `dflash` → `draft-dflash`
 * - DSpark: filename contains `dspark` and architecture is `dflash` → `draft-dspark`
 *   (DSpark extends DFlash, so there is no separate `dspark` architecture)
 * - Eagle3: filename contains `eagle3` and architecture is `eagle3` → `draft-eagle3`
 *
 * Gemma 4 `gemma4-assistant` checkpoints are attached Multi-Token Prediction
 * drafters and must be loaded with `draft-mtp` plus `--spec-draft-model`.
 * Using `draft-simple` for specialized companions crashes llama-server at load.
 *
 * @param filePath - Absolute path to the draft GGUF.
 * @param architecture - Architecture string from GGUF metadata.
 * @returns Speculative decoding type required by this companion.
 */
function specTypeForDraft(
  filePath: string,
  architecture: string,
): NonNullable<ModelEntry["draftSpecType"]> {
  const arch = architecture.toLowerCase();
  if (draftFileNameContains(filePath, "dspark") && arch === "dflash") {
    return "draft-dspark";
  }
  if (draftFileNameContains(filePath, "dflash") && arch === "dflash") {
    return "draft-dflash";
  }
  if (draftFileNameContains(filePath, "eagle3") && arch === "eagle3") {
    return "draft-eagle3";
  }
  if (arch.includes("assistant") || arch.includes("mtp")) {
    return "draft-mtp";
  }
  return "draft-simple";
}

/**
 * Writes the draft-model flag onto display metadata, returning whether it changed.
 *
 * Always recomputes from architecture and filename so a stale cache row that stored
 * `isDraftModel: false` cannot leak assistant GGUFs into the primary model list.
 *
 * @param filePath - Absolute path to the GGUF being classified.
 * @param metadata - Parsed or cached display metadata (mutated in place).
 * @returns `true` when `isDraftModel` changed and the cache should be rewritten.
 */
function applyDraftModelClassification(filePath: string, metadata: GgufDisplayMetadata): boolean {
  const isDraft = isDraftModelCandidate(filePath, metadata.architecture);
  if (metadata.isDraftModel === isDraft) {
    return false;
  }
  metadata.isDraftModel = isDraft;
  return true;
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
 * Token sets are compared rather than hyphen-joined substrings so that
 * `it-qat` vs `qat-it` still matches, and extra main-only tokens such as
 * `heretic` do not block pairing with a publisher assistant GGUF.
 *
 * @param primaryKey - Key derived from the primary GGUF filename.
 * @param candidateKey - Key derived from a companion filename.
 * @returns `true` when one token set is a subset of the other.
 */
function companionKeysAlign(primaryKey: string, candidateKey: string): boolean {
  if (!primaryKey || !candidateKey) return false;
  const primaryTokens = new Set(primaryKey.split("-").filter((token) => token.length > 0));
  const candidateTokens = new Set(candidateKey.split("-").filter((token) => token.length > 0));
  if (primaryTokens.size === 0 || candidateTokens.size === 0) return false;
  const candidateSubset = [...candidateTokens].every((token) => primaryTokens.has(token));
  const primarySubset = [...primaryTokens].every((token) => candidateTokens.has(token));
  return candidateSubset || primarySubset;
}

/**
 * Warns when more than one mmproj candidate matches a primary GGUF.
 *
 * @param primaryPath - Absolute path to the primary model file.
 * @param matches - Ambiguous companion paths.
 * @returns Always `undefined`, so the caller leaves `mmProjPath` unset.
 */
function ambiguousMmproj(primaryPath: string, matches: string[]): undefined {
  logWarn(
    `Ambiguous mmproj companions for ${primaryPath}: ${matches.join(", ")}. Leaving mmProjPath unset.`,
  );
  return undefined;
}

/**
 * Picks a unique mmproj among candidates using the project-plan rules, then token keys.
 *
 * Plan order: mmproj stem starts with the primary stem; otherwise the sole file in the
 * candidate set. Token-key equality is only used to disambiguate multiple leftovers.
 *
 * @param primaryPath - Absolute path to the primary model file.
 * @param candidates - mmproj paths already scoped (same directory, or global).
 * @returns The matching mmproj path, or `undefined` when no unique match exists.
 */
function pickUniqueMmproj(primaryPath: string, candidates: string[]): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const primaryStem = path.parse(primaryPath).name.toLowerCase();
  const stemMatches = candidates.filter((candidate) =>
    path.parse(candidate).name.toLowerCase().startsWith(primaryStem),
  );
  if (stemMatches.length === 1) {
    return stemMatches[0];
  }
  if (stemMatches.length > 1) {
    return ambiguousMmproj(primaryPath, stemMatches);
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const primaryKey = buildCompanionKey(primaryPath);
  if (!primaryKey) {
    return ambiguousMmproj(primaryPath, candidates);
  }

  const keyMatches = candidates.filter((candidate) => buildCompanionKey(candidate) === primaryKey);
  if (keyMatches.length === 1) {
    return keyMatches[0];
  }
  if (keyMatches.length > 1) {
    return ambiguousMmproj(primaryPath, keyMatches);
  }

  return ambiguousMmproj(primaryPath, candidates);
}

/**
 * Finds the best mmproj companion file for a primary GGUF model.
 *
 * Matching is same-directory first (publisher/model folder layout), then a unique
 * global token-key match when the folder has no mmproj.
 *
 * @param primaryPath - Absolute path to the primary model file.
 * @param mmprojFiles - Candidate multimodal projection files discovered during the scan.
 * @returns The matching mmproj file path, or `undefined` when no unique match exists.
 */
function findMatchingMmproj(primaryPath: string, mmprojFiles: string[]): string | undefined {
  const sameDir = mmprojFiles.filter(
    (candidate) => path.dirname(candidate) === path.dirname(primaryPath),
  );
  const sameDirMatch = pickUniqueMmproj(primaryPath, sameDir);
  if (sameDirMatch || sameDir.length > 0) {
    return sameDirMatch;
  }

  const primaryKey = buildCompanionKey(primaryPath);
  if (!primaryKey) {
    return undefined;
  }

  const globalMatches = mmprojFiles.filter(
    (candidate) => buildCompanionKey(candidate) === primaryKey,
  );
  if (globalMatches.length === 1) {
    return globalMatches[0];
  }
  if (globalMatches.length > 1) {
    return ambiguousMmproj(primaryPath, globalMatches);
  }

  return undefined;
}

/**
 * Finds the best draft model companion for a primary GGUF model.
 * Only considers draft models in the same directory as the primary model.
 *
 * A unique same-directory draft is always paired (publisher folder layout), matching
 * mmproj discovery. Token-set alignment is only used to disambiguate multiple drafts.
 *
 * @param primaryPath - Absolute path to the primary GGUF model file.
 * @param draftModels - Candidate draft model paths discovered during the scan.
 * @returns The matching draft model file path, or `undefined` when no unique match exists.
 */
function findMatchingDraftModel(primaryPath: string, draftModels: string[]): string | undefined {
  const sameDirMatches = draftModels.filter(
    (candidate) => path.dirname(candidate) === path.dirname(primaryPath),
  );
  if (sameDirMatches.length === 0) {
    return undefined;
  }
  if (sameDirMatches.length === 1) {
    return sameDirMatches[0];
  }

  const primaryKey = buildDraftCompanionKey(primaryPath);
  const aligned = primaryKey
    ? sameDirMatches.filter((candidate) =>
        companionKeysAlign(primaryKey, buildDraftCompanionKey(candidate)),
      )
    : [];
  if (aligned.length === 1) {
    return aligned[0];
  }

  logWarn(
    `Ambiguous draft models for ${primaryPath}: ${sameDirMatches.join(", ")}. Leaving draftModelPath unset.`,
  );
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
 * Primary GGUFs usually do not carry `clip.has_vision_encoder`; those keys live on the mmproj.
 * A missing companion leaves metadata unchanged. Callers that reused a cache row
 * written for a deleted mmproj must clear the flags themselves.
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
 * Mutable state shared by one model-directory walk.
 */
interface ScanWalkState {
  count: number;
  truncated: boolean;
  seen: Set<string>;
}

/**
 * Parsed llama.cpp split-GGUF filename (`name-00001-of-00003.gguf`).
 */
interface GgufShardName {
  directory: string;
  stem: string;
  index: number;
  count: number;
  indexWidth: number;
  countWidth: number;
}

/**
 * Parses a split GGUF shard name.
 *
 * @param filePath - Absolute or relative GGUF path.
 * @returns Shard identity, or `null` when the file is not a split shard.
 */
function parseGgufShardName(filePath: string): GgufShardName | null {
  const match = /^(.*)-(\d+)-of-(\d+)\.gguf$/i.exec(path.basename(filePath));
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const index = Number(match[2]);
  const count = Number(match[3]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    count < 2 ||
    index < 1 ||
    index > count
  ) {
    return null;
  }
  return {
    directory: path.dirname(filePath),
    stem: match[1],
    index,
    count,
    indexWidth: match[2].length,
    countWidth: match[3].length,
  };
}

/**
 * Sums every shard that belongs with a split GGUF, or returns the single file size.
 *
 * Only the first shard is catalogued. Its reported size includes the siblings
 * llama-server reads when that shard is loaded.
 *
 * @param filePath - Absolute path of the catalogued GGUF.
 * @param ownSize - `stat` size of `filePath`, used when the file is not a shard.
 * @returns Combined size in bytes.
 */
async function summedGgufSize(filePath: string, ownSize: number): Promise<number> {
  const shard = parseGgufShardName(filePath);
  if (shard?.index !== 1) return ownSize;
  let total = 0;
  for (let index = 1; index <= shard.count; index++) {
    const name = `${shard.stem}-${String(index).padStart(shard.indexWidth, "0")}-of-${String(shard.count).padStart(shard.countWidth, "0")}.gguf`;
    try {
      total += (await fs.stat(path.join(shard.directory, name))).size;
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`Unable to stat GGUF shard ${name}: ${message}`);
      }
    }
  }
  return total > 0 ? total : ownSize;
}

/**
 * Logs once when a scan stops because the entry budget is exhausted.
 *
 * @param state - Mutable traversal state.
 * @param options - Effective scan limits.
 * @returns No return value.
 */
function noteScanTruncated(state: ScanWalkState, options: Required<ScanOptions>): void {
  if (state.truncated || state.count < options.maxEntries) return;
  state.truncated = true;
  logWarn(
    `Model scan stopped after ${options.maxEntries} entries. Raise MODEL_SCAN_MAX_ENTRIES to continue.`,
  );
}

/**
 * Recursively walks a directory to find GGUF files, including through directory symlinks.
 *
 * Non-GGUF names are ignored. Split shards other than the first are omitted later.
 *
 * @param dir - Directory to scan.
 * @param depth - Current recursion depth.
 * @param state - Mutable traversal state tracking how many entries have been inspected.
 * @param options - Effective scan limits controlling recursion depth and entry count.
 * @returns Absolute file paths for candidate GGUF files.
 * @internal
 */
async function walkDir(
  dir: string,
  depth = 0,
  state: ScanWalkState = { count: 0, truncated: false, seen: new Set() },
  options: Required<ScanOptions>,
): Promise<string[]> {
  if (depth > options.maxDepth || state.count >= options.maxEntries) {
    noteScanTruncated(state, options);
    return [];
  }
  let realDir = dir;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    realDir = path.resolve(dir);
  }
  if (state.seen.has(realDir)) return [];
  state.seen.add(realDir);

  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      state.count++;
      if (state.count > options.maxEntries) {
        noteScanTruncated(state, options);
        break;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
      const res = path.resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let linked: Awaited<ReturnType<typeof fs.stat>> | undefined;
        try {
          linked = await fs.stat(res);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logWarn(`Skipping unreadable symlink ${res}: ${message}`);
          continue;
        }
        if (linked.isDirectory()) {
          files.push(...(await walkDir(res, depth + 1, state, options)));
        } else if (linked.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
          files.push(res);
        }
        continue;
      }
      if (entry.isDirectory()) {
        files.push(...(await walkDir(res, depth + 1, state, options)));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
        files.push(res);
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

    const allGgufFiles = await walkDir(
      rootPath,
      0,
      { count: 0, truncated: false, seen: new Set() },
      resolvedOptions,
    );
    const catalogFiles = allGgufFiles.filter((filePath) => {
      const shard = parseGgufShardName(filePath);
      return shard === null || shard.index === 1;
    });
    const mmprojFiles = catalogFiles.filter((f) =>
      path.basename(f).toUpperCase().includes("MMPROJ"),
    );
    const primaryGgufs = catalogFiles.filter(
      (f) => !path.basename(f).toUpperCase().includes("MMPROJ"),
    );

    // Detect draft models (architecture or filename tokens). They are omitted
    // from the returned catalog the same way mmproj companions are omitted.
    const draftModelPaths = new Set<string>();
    const draftSpecs = new Map<string, NonNullable<ModelEntry["draftSpecType"]>>();
    for (const filePath of primaryGgufs) {
      try {
        const stat = await fs.stat(filePath);
        let metadata = await cachedGgufMetadata(filePath, stat.mtimeMs);
        if (!metadata) {
          metadata = await ggufReader.parseGgufMetadata(filePath);
          metadata.fileSizeBytes = await summedGgufSize(filePath, stat.size);
          applyDraftModelClassification(filePath, metadata);
          await setCachedGgufMetadata(filePath, stat.mtimeMs, metadata);
        } else if (applyDraftModelClassification(filePath, metadata)) {
          await setCachedGgufMetadata(filePath, stat.mtimeMs, metadata);
        }
        if (metadata.isDraftModel) {
          draftModelPaths.add(filePath);
          draftSpecs.set(filePath, specTypeForDraft(filePath, metadata.architecture));
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
      const draftSpecType = draftModelPath ? draftSpecs.get(draftModelPath) : undefined;

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
            metadata.fileSizeBytes = await summedGgufSize(primaryPath, stat.size);
          } else if (!mmProjPath) {
            metadata.hasVisionEncoder = false;
            metadata.hasAudioEncoder = false;
          }
          metadata.fileSizeBytes = await summedGgufSize(primaryPath, stat.size);
          applyDraftModelClassification(primaryPath, metadata);
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
        draftSpecType,
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
          metadata.fileSizeBytes = await summedGgufSize(entry.primaryPath, stat.size);
        } else if (!entry.mmProjPath) {
          metadata.hasVisionEncoder = false;
          metadata.hasAudioEncoder = false;
        }
        metadata.fileSizeBytes = await summedGgufSize(entry.primaryPath, stat.size);
        applyDraftModelClassification(entry.primaryPath, metadata);

        await mergeMmprojEncoderFlags(metadata, entry.mmProjPath);
        await setCachedGgufMetadata(entry.primaryPath, mtime, metadata, {
          mmprojPath: companion?.path ?? "",
          mmprojMtime: companion?.mtime ?? 0,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`Failed to parse GGUF metadata for ${entry.primaryPath}: ${message}`);
      }
    } else if (applyDraftModelClassification(entry.primaryPath, metadata)) {
      await setCachedGgufMetadata(entry.primaryPath, mtime, metadata, {
        mmprojPath: companion?.path ?? "",
        mmprojMtime: companion?.mtime ?? 0,
      });
    }

    if (metadata) {
      const summedSize = await summedGgufSize(entry.primaryPath, stat.size);
      if (metadata.fileSizeBytes !== summedSize) {
        metadata.fileSizeBytes = summedSize;
        await setCachedGgufMetadata(entry.primaryPath, mtime, metadata, {
          mmprojPath: companion?.path ?? "",
          mmprojMtime: companion?.mtime ?? 0,
        });
      }
    }

    return metadata ? { ...entry, metadata } : entry;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`Unable to populate metadata for ${entry.primaryPath}: ${message}`);
    return entry;
  }
}
