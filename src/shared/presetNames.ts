/**
 * @packageDocumentation
 * Names for load, inference, and system presets, and for model rows that share
 * a folder. A list entry uses the word "default" at most once, never says
 * "(from GGUF)", and never repeats a model name that is already on the row.
 * Two presets in the same list cannot share a name.
 */

import { modelPathsMatch } from "./templateCapabilities";

/**
 * A scanned model file, as much of it as naming needs.
 */
export interface PresetNameModel {
  /** Folder title, or the file name when the GGUF sits directly in the library root. */
  modelName: string;
  /** Absolute path of the primary GGUF. */
  primaryPath: string;
  /** Scan metadata. Draft companions are ignored when choosing a label. */
  metadata?: { isDraftModel?: boolean } | undefined;
}

/**
 * One stored preset row, as much of it as renaming needs.
 */
export interface PresetNameRow {
  /** Preset identifier. */
  id: string;
  /** Name currently stored. */
  name: string;
  /** Creation time. Older rows keep a shared name; newer rows are renamed. */
  createdAt: number;
  /** Read-only presets keep their name unless it literally collides with another row. */
  isReadonly?: boolean;
  /** GGUF this preset is bound to, or blank when the preset is global. */
  modelPath?: string | null | undefined;
}

/**
 * A row that might be marked as the single default preset.
 */
export interface DefaultCandidate {
  /** Preset identifier. */
  id: string;
  /** Whether the row is currently marked default. */
  isDefault: boolean;
  /** Read-only global presets outrank a model-bound row. */
  isReadonly?: boolean;
  /** Bound GGUF. Blank means the preset applies to every model. */
  boundPath?: string | null | undefined;
  /** Creation time, used when two rows are otherwise equal. */
  createdAt: number;
}

/**
 * Pieces of an old auto-generated name, `Default (from GGUF) for <model>`.
 */
export interface LegacyAutoPresetName {
  /** Text that followed `for`, with a trailing copy suffix removed. */
  modelPart: string;
  /**
   * Copy generation when the old name ended in `(Copy)` or `(Copy N)`.
   * `null` when it was the original generated row.
   */
  copy: number | null;
}

const COPY_SUFFIX = /^(.*) \(Copy(?: (\d+))?\)$/i;
const LEGACY_AUTO_NAME = /^Default \(from GGUF\) for (.+)$/i;
const DEFAULT_WORD = /\bdefault\b/i;

/**
 * Trims a preset name and collapses nothing inside it.
 *
 * @param name - Raw name from the editor or the database.
 * @returns The name with surrounding whitespace removed.
 */
function trimmedName(name: string): string {
  return name.trim();
}

/**
 * Case-insensitive identity of a preset name.
 *
 * @param name - Preset name.
 * @returns The comparison key.
 */
function nameKey(name: string): string {
  return trimmedName(name).toLowerCase();
}

/**
 * File name of a GGUF without the extension.
 *
 * @param filePath - Absolute or relative path.
 * @returns The last path segment, minus a trailing `.gguf`.
 */
export function fileStem(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = (slash >= 0 ? filePath.slice(slash + 1) : filePath).trim();
  const stripped = base.replace(/\.gguf$/i, "").trim();
  return stripped || base || "model";
}

/**
 * Reads an old generated name.
 *
 * @param name - Stored preset name.
 * @returns The model text and copy generation, or `null` when the name was chosen by hand.
 */
export function parseLegacyAutoPresetName(name: string): LegacyAutoPresetName | null {
  const match = trimmedName(name).match(LEGACY_AUTO_NAME);
  const rest = match?.[1]?.trim();
  if (!rest) return null;
  const copy = rest.match(COPY_SUFFIX);
  const modelPart = copy?.[1]?.trim();
  if (modelPart) {
    const generation = copy?.[2] ? Number(copy[2]) : 1;
    if (Number.isFinite(generation) && generation >= 1) {
      return { modelPart, copy: generation };
    }
  }
  return { modelPart: rest, copy: null };
}

/**
 * Picks a name that is not already in `taken`.
 *
 * Comparison ignores case and surrounding whitespace. A taken `Name` becomes
 * `Name (2)`. A taken `Name (Copy)` becomes `Name (Copy 2)`.
 *
 * @param desired - Name the caller would like to store.
 * @param taken - Names already used in the same preset list.
 * @returns A name that does not collide with `taken`.
 */
export function allocateUniqueName(desired: string, taken: readonly string[]): string {
  const used = new Set(taken.map(nameKey).filter((key) => key.length > 0));
  const base = trimmedName(desired) || "Preset";
  if (!used.has(nameKey(base))) return base;

  const copy = base.match(COPY_SUFFIX);
  const copyStem = copy?.[1]?.trim();
  if (copyStem) {
    const start = copy?.[2] ? Number(copy[2]) + 1 : 2;
    for (let generation = start; generation < start + 10000; generation++) {
      const candidate = `${copyStem} (Copy ${generation})`;
      if (!used.has(nameKey(candidate))) return candidate;
    }
  }

  for (let generation = 2; generation < 10000; generation++) {
    const candidate = `${base} (${generation})`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
  return `${base} (${used.size + 2})`;
}

/**
 * Names a duplicate of `name` without stacking `(Copy)` onto itself.
 *
 * @param name - Preset being duplicated.
 * @param taken - Names already used in that preset list, including `name`.
 * @returns `Name (Copy)`, or `Name (Copy 2)` when that is already taken.
 */
export function duplicatePresetName(name: string, taken: readonly string[]): string {
  const stripped =
    trimmedName(name)
      .replace(/ \(Copy(?: \d+)?\)$/i, "")
      .trim() || "Preset";
  return allocateUniqueName(`${stripped} (Copy)`, taken);
}

/**
 * Menu text for one preset.
 *
 * The word "default" is added only when the preset is the marked default and
 * the name does not already contain that word. The bound file is not appended;
 * the stored name is already the identity of that preset.
 *
 * @param name - Stored preset name.
 * @param isDefault - Whether this row is the marked default.
 * @returns The single-line label.
 */
export function presetListLabel(name: string, isDefault: boolean): string {
  const trimmed = trimmedName(name);
  if (!trimmed) return isDefault ? "Preset (Default)" : "Preset";
  if (!isDefault || DEFAULT_WORD.test(trimmed)) return trimmed;
  return `${trimmed} (Default)`;
}

/**
 * Labels every preset in one menu so two rows cannot display the same text.
 *
 * @param presets - Presets in menu order.
 * @returns Display text keyed by preset id.
 */
export function presetMenuLabels<T extends { id: string; name: string; isDefault: boolean }>(
  presets: readonly T[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const used: string[] = [];
  for (const preset of presets) {
    const label = allocateUniqueName(presetListLabel(preset.name, preset.isDefault), used);
    used.push(label);
    labels.set(preset.id, label);
  }
  return labels;
}

/**
 * Label for a model card, chat header, or library row.
 *
 * One file in a folder keeps the folder title. A second quant of that same
 * folder is labeled with its own file name, so both files show up as different
 * choices. The folder title is not written out again next to the file name.
 *
 * @param model - Model being labeled.
 * @param models - Models in the same list, including `model`. Drafts should already be omitted.
 * @returns The label to show for `model`.
 */
export function modelOptionLabel(
  model: { modelName: string; primaryPath: string },
  models: readonly { modelName: string; primaryPath: string }[],
): string {
  const ownName = model.modelName.trim() || fileStem(model.primaryPath);
  const group = models.filter((entry) => {
    const entryName = entry.modelName.trim() || fileStem(entry.primaryPath);
    return nameKey(entryName) === nameKey(ownName);
  });
  const withSelf = group.some((entry) => modelPathsMatch(entry.primaryPath, model.primaryPath))
    ? group
    : [...group, model];
  if (withSelf.length <= 1) return ownName;

  const stem = fileStem(model.primaryPath);
  const sameStem = withSelf.filter(
    (entry) => nameKey(fileStem(entry.primaryPath)) === nameKey(stem),
  );
  if (sameStem.length <= 1) return stem;

  const ordered = [...sameStem].sort((left, right) =>
    left.primaryPath.replace(/\\/g, "/").localeCompare(right.primaryPath.replace(/\\/g, "/")),
  );
  const index = ordered.findIndex((entry) => modelPathsMatch(entry.primaryPath, model.primaryPath));
  if (index <= 0) return stem;
  return `${stem} (${index + 1})`;
}

/**
 * Stored name for a preset generated for one model file.
 *
 * Matches {@link modelOptionLabel}: the folder title when that folder has one
 * GGUF, and the file name when several quants share the folder.
 *
 * @param model - Model the preset belongs to.
 * @param models - Visible models, used to see whether the folder title is shared.
 * @returns The name to store.
 */
export function autoPresetName(
  model: { modelName: string; primaryPath: string },
  models: readonly { modelName: string; primaryPath: string }[],
): string {
  return modelOptionLabel(model, models);
}

/**
 * Replacement for one old generated name.
 *
 * @param legacy - Parsed `Default (from GGUF) for ...` name.
 * @param modelPath - GGUF the preset is bound to, if any.
 * @param models - Visible models from the current scan.
 * @returns The name to store before uniqueness is applied.
 */
function legacyDesiredName(
  legacy: LegacyAutoPresetName,
  modelPath: string | null | undefined,
  models: readonly PresetNameModel[],
): string {
  const bound = modelPath?.trim()
    ? models.find((model) => modelPathsMatch(model.primaryPath, modelPath))
    : undefined;
  const base = bound
    ? autoPresetName(bound, models)
    : modelPath?.trim()
      ? fileStem(modelPath)
      : legacy.modelPart || "Preset";
  if (legacy.copy === null) return base;
  return legacy.copy > 1 ? `${base} (Copy ${legacy.copy})` : `${base} (Copy)`;
}

/**
 * Assigns a unique stored name to every preset.
 *
 * Hand-written names are kept. Old `Default (from GGUF) for ...` names are
 * replaced with the folder title, or with the file name when that folder has
 * more than one quant. A name that is still taken becomes `Name (2)` or
 * `Name (Copy N)`. Read-only names are only changed when they collide.
 *
 * @param presets - Rows in one preset table.
 * @param models - Models from the current scan. Drafts are ignored.
 * @returns The name each id should store. Missing ids were not in `presets`.
 */
export function assignUniquePresetNames(
  presets: readonly PresetNameRow[],
  models: readonly PresetNameModel[],
): Map<string, string> {
  const catalog = models.filter((model) => !model.metadata?.isDraftModel);
  const ordered = [...presets].sort((left, right) => {
    const legacyLeft = parseLegacyAutoPresetName(left.name) ? 1 : 0;
    const legacyRight = parseLegacyAutoPresetName(right.name) ? 1 : 0;
    if (legacyLeft !== legacyRight) return legacyLeft - legacyRight;
    const readonlyLeft = left.isReadonly ? 0 : 1;
    const readonlyRight = right.isReadonly ? 0 : 1;
    if (readonlyLeft !== readonlyRight) return readonlyLeft - readonlyRight;
    return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
  });

  const assigned = new Map<string, string>();
  const used: string[] = [];
  for (const preset of ordered) {
    const legacy = preset.isReadonly ? null : parseLegacyAutoPresetName(preset.name);
    const desired = legacy ? legacyDesiredName(legacy, preset.modelPath, catalog) : preset.name;
    const unique = allocateUniqueName(desired, used);
    used.push(unique);
    assigned.set(preset.id, unique);
  }
  return assigned;
}

/**
 * Chooses the one row that should stay marked as the default.
 *
 * A read-only preset with no model file wins, then any other unbound preset,
 * then the oldest marked row. Rows that are not marked are not promoted.
 *
 * @param presets - Presets in one list.
 * @returns The id to leave marked, or `undefined` when none are marked.
 */
export function preferredDefaultId(presets: readonly DefaultCandidate[]): string | undefined {
  const marked = presets.filter((preset) => preset.isDefault);
  if (marked.length === 0) return undefined;
  const ranked = [...marked].sort((left, right) => {
    const score = (preset: DefaultCandidate) =>
      (preset.isReadonly ? 4 : 0) + ((preset.boundPath?.trim() ?? "") === "" ? 2 : 0);
    return (
      score(right) - score(left) ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id)
    );
  });
  return ranked[0]?.id;
}

/**
 * Keeps a repaired name when a stale editor sends the old generated name back.
 *
 * @param requested - Name from the save request.
 * @param stored - Name currently in the database.
 * @param taken - Names used by other presets in the same list.
 * @returns The name to persist.
 */
export function resolveStoredPresetName(
  requested: string,
  stored: string,
  taken: readonly string[],
): string {
  if (parseLegacyAutoPresetName(requested) && !parseLegacyAutoPresetName(stored)) {
    return allocateUniqueName(stored, taken);
  }
  return allocateUniqueName(requested, taken);
}
