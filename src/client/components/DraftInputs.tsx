/**
 * @packageDocumentation
 * Text and number inputs that keep a raw draft until the value can be parsed.
 */

import { useEffect, useRef, useState } from "react";

/**
 * Result of parsing a free-form editor field.
 */
export type DraftParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Splits a comma-separated stop-string field.
 *
 * Empty pieces are dropped so a trailing comma can be typed before the next word.
 *
 * @param raw - Current text in the stop-string field.
 * @returns Trimmed stop strings, in order.
 */
export function parseStopStrings(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Formats stored stop strings for the editor.
 *
 * @param values - Stored stop strings.
 * @returns Comma-separated text.
 */
export function formatStopStrings(values: string[] | undefined): string {
  return (values ?? []).join(", ");
}

/**
 * Parses a tensor-split field into finite numbers.
 *
 * A trailing comma is ignored so `"3,"` is not stored as `NaN`. An empty field
 * clears the split. Blank pieces in the middle are rejected.
 *
 * @param raw - Current text in the tensor-split field.
 * @returns The parsed ratios, or a message explaining why the text is not ready.
 */
export function parseTensorSplit(raw: string): DraftParseResult<number[] | undefined> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const pieces = trimmed.split(",").map((part) => part.trim());
  const numbers = pieces[pieces.length - 1] === "" ? pieces.slice(0, -1) : pieces;
  if (
    numbers.length === 0 ||
    numbers.some((part) => part.length === 0 || !Number.isFinite(Number(part)))
  ) {
    return { ok: false, message: "Enter finite numbers separated by commas." };
  }
  return { ok: true, value: numbers.map((part) => Number(part)) };
}

/**
 * Formats a tensor split for the editor.
 *
 * @param values - Stored per-GPU ratios.
 * @returns Comma-separated numbers, or an empty string when unset.
 */
export function formatTensorSplit(values: number[] | undefined): string {
  return values?.join(",") ?? "";
}

/**
 * Parses the DRY sequence-breaker field as a JSON array of strings.
 *
 * @param raw - Current text in the sequence-breaker field.
 * @returns The string array, or a message explaining why the JSON is not usable.
 */
export function parseSequenceBreakers(raw: string): DraftParseResult<string[]> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      return { ok: false, message: "Sequence breakers must be a JSON array of strings." };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, message: "Sequence breakers must be valid JSON." };
  }
}

/**
 * Parses a tool-argument draft as a JSON object.
 *
 * @param raw - Text from the tool-argument editor.
 * @returns The original text when it is a JSON object, or a validation message.
 */
export function parseToolArguments(raw: string): DraftParseResult<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: "Arguments must be a JSON object." };
    }
    return { ok: true, value: raw };
  } catch {
    return { ok: false, message: "Arguments must be valid JSON." };
  }
}

/**
 * Reports whether an editor draft differs from the saved preset.
 *
 * `createdAt` and `updatedAt` are ignored. The server stamps a new
 * `updatedAt` on every successful save, and that stamp is not an unsaved edit.
 * Key order is ignored so a refetched row matches the draft that was sent.
 * Numbers are compared to six decimal places so float32 sampling values match
 * the slider position the editor shows.
 *
 * @param draft - Current editor state.
 * @param saved - Preset loaded from the server, or the payload last sent.
 * @returns `true` when the editable values differ.
 */
export function presetDraftIsDirty(draft: unknown, saved: unknown): boolean {
  if (draft == null || saved == null) return false;
  return (
    JSON.stringify(canonicalizePresetDraft(draft)) !==
    JSON.stringify(canonicalizePresetDraft(saved))
  );
}

/**
 * Copies a preset into editor state without sharing nested config.
 *
 * @param preset - Preset to copy.
 * @returns A shallow copy, with `config` copied when it is an object.
 */
export function clonePresetDraft<T>(preset: T): T {
  if (!preset || typeof preset !== "object") return preset;
  const record = preset as T & { config?: object };
  if (record.config && typeof record.config === "object") {
    return { ...record, config: { ...record.config } };
  }
  return { ...record };
}

/**
 * Chooses the editor draft after the preset list refreshes.
 *
 * A save records the payload that was sent. When that draft is still on screen
 * and the server row matches it, the editor adopts the server row so the new
 * timestamp does not look like an unsaved edit. A change made after the save
 * click is left in place.
 *
 * @param previous - Draft currently on screen.
 * @param incoming - Preset row from the latest server list.
 * @param pendingSavedJson - JSON of the payload sent by the in-flight save.
 * @returns The draft the editor should show.
 */
export function resolvePresetEditorState<T extends { id?: string }>(
  previous: T | null,
  incoming: T,
  pendingSavedJson: { current: string | null },
): T {
  if (!previous || previous.id !== incoming.id) {
    pendingSavedJson.current = null;
    return clonePresetDraft(incoming);
  }
  const pending = pendingSavedJson.current;
  if (pending === null) return previous;
  let sent: unknown;
  try {
    sent = JSON.parse(pending) as unknown;
  } catch {
    pendingSavedJson.current = null;
    return previous;
  }
  if (!presetDraftIsDirty(previous, sent) && !presetDraftIsDirty(incoming, sent)) {
    pendingSavedJson.current = null;
    return clonePresetDraft(incoming);
  }
  return previous;
}

/**
 * Builds a stable JSON-ready value for a preset draft comparison.
 *
 * @param value - Draft, saved preset, or nested field.
 * @returns A key-sorted copy without timestamps or `undefined` fields.
 */
function canonicalizePresetDraft(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizePresetDraft(entry));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    // GGUF sampling metadata is float32. A stored 0.1 can come back as
    // 0.10000000149011612, which a slider then snaps to 0.1.
    return Math.round(value * 1_000_000) / 1_000_000;
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (key === "createdAt" || key === "updatedAt") continue;
    const child = source[key];
    if (child === undefined) continue;
    sorted[key] = canonicalizePresetDraft(child);
  }
  return sorted;
}

/**
 * Asks before throwing away unsaved preset edits.
 *
 * @param dirty - Whether the editor has changes that are not saved.
 * @returns `true` when the caller may leave the current preset.
 */
export function confirmDiscardUnsaved(dirty: boolean): boolean {
  if (!dirty) return true;
  return window.confirm("Discard unsaved edits to this preset?");
}

/**
 * Properties for {@link NumberDraftInput}.
 */
interface NumberDraftInputProps {
  /** Input id wired to the field label. */
  id: string;
  /** Last committed number. `undefined` displays as empty when `allowEmpty` is set. */
  value: number | undefined;
  /** Writes a parsed number, or `undefined` when an empty field is allowed. */
  onCommit: (value: number | undefined) => void;
  /** Accept only integers. Decimal drafts are kept until blur, then rejected. */
  integer?: boolean;
  /** Lowest value accepted on blur. */
  min?: number;
  /** Highest value accepted on blur. */
  max?: number;
  /** When true, an empty field commits `undefined` instead of restoring the last value. */
  allowEmpty?: boolean;
  /** Disables editing. */
  disabled?: boolean | undefined;
  /** Extra classes for the input element. */
  className?: string;
  /** Placeholder shown while the draft is empty. */
  placeholder?: string;
}

/**
 * Number input whose visible text is independent of the last valid value.
 *
 * Clearing the field or typing `-` stays on screen. The parsed number is written
 * on blur. An incomplete draft restores the previous value instead of storing `NaN`.
 *
 * @param props - Bound value and commit callback.
 * @returns The draft number field.
 */
export function NumberDraftInput({
  id,
  value,
  onCommit,
  integer = false,
  min,
  max,
  allowEmpty = false,
  disabled = false,
  className,
  placeholder,
}: NumberDraftInputProps) {
  const [draft, setDraft] = useState(() => formatNumberDraft(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(formatNumberDraft(value));
  }, [value]);

  return (
    <input
      id={id}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => {
        const next = event.target.value;
        if (isPermittedNumberDraft(next, integer)) setDraft(next);
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (allowEmpty && draft.trim() === "") {
          setDraft("");
          if (value !== undefined) onCommit(undefined);
          return;
        }
        const parsed = parseNumberDraft(draft, integer, min, max);
        if (parsed === null) {
          setDraft(formatNumberDraft(value));
          return;
        }
        setDraft(String(parsed));
        if (parsed !== value) onCommit(parsed);
      }}
      className={className}
    />
  );
}

/**
 * Properties for {@link ParsedTextDraftInput}.
 */
interface ParsedTextDraftInputProps<T> {
  /** Input id wired to the field label. */
  id: string;
  /** Text that represents the last committed value. */
  committedText: string;
  /** Parses the draft. A failure keeps the typed text and shows `message`. */
  parse: (raw: string) => DraftParseResult<T>;
  /** Receives the parsed value after a successful blur. */
  onCommit: (value: T) => void;
  /** Reports whether the current draft can be saved. */
  onValidityChange?: (valid: boolean) => void;
  /** Disables editing. */
  disabled?: boolean | undefined;
  /** Extra classes for the input element. */
  className?: string;
  /** Placeholder shown while the draft is empty. */
  placeholder?: string;
}

/**
 * Text input that commits only when `parse` accepts the draft.
 *
 * @param props - Committed text, parser, and commit callback.
 * @returns The draft text field and its validation message.
 */
export function ParsedTextDraftInput<T>({
  id,
  committedText,
  parse,
  onCommit,
  onValidityChange,
  disabled = false,
  className,
  placeholder,
}: ParsedTextDraftInputProps<T>) {
  const [draft, setDraft] = useState(committedText);
  const [error, setError] = useState<string | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(committedText);
      setError(null);
    }
  }, [committedText]);

  useEffect(() => {
    return () => onValidityChange?.(true);
  }, [onValidityChange]);

  return (
    <div>
      <input
        id={id}
        type="text"
        disabled={disabled}
        placeholder={placeholder}
        value={draft}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error) {
            setError(null);
            onValidityChange?.(true);
          }
        }}
        onBlur={() => {
          focusedRef.current = false;
          const result = parse(draft);
          if (!result.ok) {
            setError(result.message);
            onValidityChange?.(false);
            return;
          }
          setError(null);
          onValidityChange?.(true);
          onCommit(result.value);
        }}
        className={className}
      />
      {error ? (
        <p className="mt-1 text-xs text-[var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Properties for {@link PresetSaveStatus}.
 */
interface PresetSaveStatusProps {
  /** Status text. Nothing is rendered when this is null. */
  message: string | null;
  /** Whether the message describes a failure. */
  error?: boolean;
}

/**
 * One-line save result under a preset editor's action button.
 *
 * @param props - Message and tone.
 * @returns The status line, or `null` when there is nothing to report.
 */
export function PresetSaveStatus({ message, error = false }: PresetSaveStatusProps) {
  if (!message) return null;
  return (
    <p
      className={`text-xs ${error ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}
      role="status">
      {message}
    </p>
  );
}

/**
 * Formats a committed number for the draft display.
 *
 * @param value - Stored number, if any.
 * @returns Decimal text, or an empty string when the value is absent.
 */
function formatNumberDraft(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * Allows an in-progress numeric draft, including a lone minus sign.
 *
 * @param raw - Text the user has typed.
 * @param integer - Whether a decimal point is forbidden.
 * @returns `true` when the text can stay in the field.
 */
function isPermittedNumberDraft(raw: string, integer: boolean): boolean {
  if (raw === "" || raw === "-") return true;
  if (integer) return /^-?\d+$/.test(raw);
  return /^-?\d*(?:\.\d*)?$/.test(raw);
}

/**
 * Parses a finished numeric draft.
 *
 * @param raw - Text present when the field loses focus.
 * @param integer - Whether the value must be an integer.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @returns The number to store, or `null` when the draft should be discarded.
 */
function parseNumberDraft(
  raw: string,
  integer: boolean,
  min: number | undefined,
  max: number | undefined,
): number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-" || trimmed === "." || trimmed === "-.") return null;
  const parsed = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  if (integer && !Number.isInteger(parsed)) return null;
  if (min !== undefined && parsed < min) return null;
  if (max !== undefined && parsed > max) return null;
  return parsed;
}
