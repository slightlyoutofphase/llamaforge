/**
 * @packageDocumentation
 * Sidebar panel for editing inference presets (sampling, dynamic penalties, structured output, and tools).
 */

import { json } from "@codemirror/lang-json";
import CodeMirror from "@uiw/react-codemirror";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createDefaultInferenceSampling } from "../../../shared/defaults";
import {
  allocateUniqueName,
  duplicatePresetName,
  presetMenuLabels,
} from "../../../shared/presetNames";
import { copyInferencePresetSettings, presetAppliesToModel } from "../../../shared/presetScope";
import { chatTemplateSupportsToolCalling } from "../../../shared/templateCapabilities";
import { toStoredToolDefinition } from "../../../shared/toolModule";
import type { AvailableTool, InferencePreset, ToolDefinition } from "../../../shared/types";
import {
  useAvailableTools,
  useCreateInferencePreset,
  useDeleteInferencePreset,
  useInferencePresets,
  useUpdateInferencePreset,
} from "../../queries";
import {
  confirmDiscardUnsaved,
  formatStopStrings,
  NumberDraftInput,
  ParsedTextDraftInput,
  parseSequenceBreakers,
  parseStopStrings,
  PresetSaveStatus,
  presetDraftIsDirty,
  resolvePresetEditorState,
} from "../DraftInputs";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { useResolvedTheme } from "../../useResolvedTheme";

type CatalogTool = ToolDefinition & {
  source?: AvailableTool["source"];
};

/** Slider steps in the inference editor. Values are snapped before they are saved. */
const INFERENCE_SLIDER_STEPS: Partial<Record<keyof InferencePreset, number>> = {
  temperature: 0.05,
  topP: 0.05,
  minP: 0.01,
  topK: 1,
  typicalP: 0.05,
  repeatPenalty: 0.05,
  presencePenalty: 0.1,
  frequencyPenalty: 0.1,
  dryMultiplier: 0.1,
  xtcProbability: 0.05,
  xtcThreshold: 0.01,
};

/**
 * Moves one sampling value onto its slider step.
 *
 * GGUF metadata stores these as float32. The raw value is not a valid position
 * for the range input, so the browser rewrites it and the draft looks unsaved.
 *
 * @param value - Stored sampling value.
 * @param step - Slider step for that field.
 * @returns The nearest step, without binary residue.
 */
function snapSliderValue(value: number, step: number): number {
  const snapped = Math.round(value / step) * step;
  const decimals = (step.toString().split(".")[1] ?? "").length;
  return Number(snapped.toFixed(decimals));
}

/**
 * Snaps inference slider fields onto the steps the editor can actually display.
 *
 * @param preset - Draft about to be shown or saved.
 * @returns A copy with slider fields quantized.
 */
function snapInferenceSliders<T extends Partial<InferencePreset>>(preset: T): T {
  const next: T = { ...preset };
  for (const [key, step] of Object.entries(INFERENCE_SLIDER_STEPS)) {
    if (!step) continue;
    const current = next[key as keyof T];
    if (typeof current !== "number" || !Number.isFinite(current)) continue;
    (next as Record<string, unknown>)[key] = snapSliderValue(current, step);
  }
  return next;
}

/**
 * Merges the live tool catalog with tools already stored on the inference preset.
 * Discovered tools win so descriptions stay current; preset-only entries remain listed.
 *
 * @param available - Tools reported by the server, if loaded.
 * @param presetTools - Tools currently enabled on the edited preset.
 * @returns Unique tools in catalog order, then leftover preset tools.
 */
function catalogTools(
  available: AvailableTool[] | undefined,
  presetTools: ToolDefinition[],
): CatalogTool[] {
  const byName = new Map<string, CatalogTool>();
  for (const tool of available ?? []) {
    byName.set(tool.name, tool);
  }
  for (const tool of presetTools) {
    if (!byName.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }
  return [...byName.values()];
}

/**
 * Component for managing and editing inference presets.
 * Includes sliders for sampling params, a JSON editor for structured output, tool toggles, and lifecycle actions (new, duplicate, copy from, delete).
 *
 * @returns React functional component.
 */
export function InferencePresetEditor() {
  const codeMirrorTheme = useResolvedTheme();
  const { setRightPanelView, activePresetId } = useUiStore();
  const { data: presets } = useInferencePresets();
  const { data: toolsCatalog, isPending: toolsPending, isError: toolsError } = useAvailableTools();
  const loadedModel = useAppStore((s) => s.loadedModel);
  const loadedConfig = useAppStore((s) => s.loadedConfig);
  const serverStatus = useAppStore((s) => s.serverStatus);
  const [schemaDraft, setSchemaDraft] = useState("{}");
  const createMut = useCreateInferencePreset();
  const updateMut = useUpdateInferencePreset();
  const deleteMut = useDeleteInferencePreset();

  const activePreset = presets?.find((p) => p.id === activePresetId) || presets?.[0];
  const listedPresets = (presets ?? []).filter((preset) => {
    if (preset.id === activePreset?.id) return true;
    if (!loadedModel?.primaryPath) return true;
    return presetAppliesToModel(preset.sourceModelPath, loadedModel.primaryPath);
  });
  const copySources = (presets ?? [])
    .filter((preset) => preset.id !== activePreset?.id)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const [localState, setLocalState] = useState<Partial<InferencePreset> | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [fieldValid, setFieldValid] = useState(true);
  const pendingSavedJson = useRef<string | null>(null);

  useEffect(() => {
    if (!activePreset) return;
    setLocalState((prev) =>
      resolvePresetEditorState(prev, snapInferenceSliders(activePreset), pendingSavedJson),
    );
  }, [activePreset]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the schema editor when switching presets, not on every local keystroke
  useEffect(() => {
    setSchemaDraft(
      localState?.structuredOutput?.schema
        ? JSON.stringify(localState.structuredOutput.schema, null, 2)
        : "{}",
    );
  }, [localState?.id, localState?.structuredOutput?.schema]);

  if (!localState) return <div className="w-80 shrink-0 bg-[var(--color-surface)] border-l" />;

  const listedLabels = presetMenuLabels(listedPresets);
  const copyLabels = presetMenuLabels(copySources);

  const toolsSupported =
    serverStatus !== "running" ||
    !loadedModel ||
    chatTemplateSupportsToolCalling(
      loadedConfig?.chatTemplateContent,
      loadedModel.metadata?.chatTemplate,
      loadedModel.metadata?.hasToolCalling,
    );
  const toolsEnableLocked = !toolsSupported && !localState.toolCallsEnabled;

  /**
   * Updates a single inference preset field within local editor state.
   *
   * @param k - Field name to update.
   * @param v - New field value.
   * @returns No return value.
   */
  const updateField = <K extends keyof InferencePreset>(k: K, v: InferencePreset[K]) => {
    setLocalState((prev) => (prev ? { ...prev, [k]: v } : null));
  };

  /**
   * Enables or disables a discovered tool on the current inference preset.
   *
   * @param tool - Tool definition to toggle.
   * @param enabled - Whether the tool should be present in the preset.
   * @returns No return value.
   */
  const toggleTool = (tool: ToolDefinition, enabled: boolean) => {
    setLocalState((prev) => {
      if (!prev) return prev;
      const current = prev.tools ?? [];
      const stored = toStoredToolDefinition(tool);
      if (enabled) {
        if (current.some((entry) => entry.name === stored.name)) return prev;
        return { ...prev, tools: [...current, stored] };
      }
      return { ...prev, tools: current.filter((entry) => entry.name !== stored.name) };
    });
  };

  /**
   * Persists the currently edited inference preset.
   *
   * @returns No return value.
   */
  const handleSave = () => {
    if (!localState.id) return;
    if (!fieldValid) {
      setSaveError(true);
      setSaveMessage("Fix the highlighted field before saving.");
      return;
    }
    const name = allocateUniqueName(
      localState.name ?? "",
      (presets ?? []).filter((preset) => preset.id !== localState.id).map((preset) => preset.name),
    );
    const next = snapInferenceSliders({ ...localState, name });
    setLocalState(next);
    pendingSavedJson.current = JSON.stringify(next);
    updateMut.mutate(
      { id: localState.id, updates: next },
      {
        onSuccess: () => {
          setSaveError(false);
          setSaveMessage("Saved.");
        },
        onError: (error: unknown) => {
          setSaveError(true);
          setSaveMessage(error instanceof Error ? error.message : "Save failed.");
        },
      },
    );
  };

  /**
   * Leaves the current preset after confirming when the draft has unsaved edits.
   *
   * @param nextId - Preset id to open, or `null` to close the editor.
   * @returns No return value.
   */
  const requestPresetChange = (nextId: string | null) => {
    if (!confirmDiscardUnsaved(presetDraftIsDirty(localState, activePreset) || !fieldValid)) {
      return;
    }
    setSaveMessage(null);
    if (nextId === null) {
      setRightPanelView("settings");
      return;
    }
    setRightPanelView("inferencePreset", nextId);
  };

  /**
   * Copies another preset's sampling onto this one, keeping this preset's model binding.
   *
   * @param sourceId - Preset to copy settings from.
   * @returns No return value.
   */
  const handleCopyFrom = (sourceId: string) => {
    if (!localState?.id) return;
    const source = presets?.find((preset) => preset.id === sourceId);
    if (!source) return;
    setLocalState(copyInferencePresetSettings(localState as InferencePreset, source));
  };

  /**
   * Duplicates the current inference preset and opens the clone for editing.
   *
   * @returns No return value.
   */
  const handleDuplicate = () => {
    if (!localState) return;
    const newPreset: InferencePreset = {
      ...(localState as InferencePreset),
      id: crypto.randomUUID(),
      name: duplicatePresetName(
        localState.name ?? "Preset",
        (presets ?? []).map((preset) => preset.name),
      ),
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("inferencePreset", newPreset.id);
  };

  /**
   * Creates a brand-new inference preset with default sampling values.
   *
   * @returns No return value.
   */
  const handleNew = () => {
    const newPreset: InferencePreset = {
      id: crypto.randomUUID(),
      name: allocateUniqueName(
        "New Inference Preset",
        (presets ?? []).map((preset) => preset.name),
      ),
      isDefault: false,
      ...createDefaultInferenceSampling(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("inferencePreset", newPreset.id);
  };

  /**
   * Deletes the currently selected inference preset when it is mutable.
   *
   * @returns No return value.
   */
  const handleDelete = () => {
    if (!localState.id || localState.isDefault) return;
    if (!window.confirm(`Delete preset "${localState.name || "this preset"}"?`)) return;
    deleteMut.mutate(localState.id, {
      onSuccess: () => {
        setSaveError(false);
        setSaveMessage("Deleted.");
      },
      onError: (error: unknown) => {
        setSaveError(true);
        setSaveMessage(error instanceof Error ? error.message : "Delete failed.");
      },
    });
    setRightPanelView("inferencePreset", presets?.find((p) => p.id !== localState.id)?.id);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-96 shadow-xl overflow-hidden shrink-0">
      <div className="border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between p-4 gap-2">
          <div className="flex flex-col flex-1 min-w-0">
            <h2 className="font-semibold text-lg flex items-center gap-2 truncate">
              Inference Preset
            </h2>
            <select
              aria-label="Inference preset"
              value={activePreset?.id || ""}
              onChange={(e) => requestPresetChange(e.target.value)}
              className="text-xs bg-transparent border-none text-[var(--color-text-muted)] outline-none focus:text-[var(--color-text-primary)] w-full">
              {listedPresets.map((p) => (
                <option key={p.id} value={p.id} className="bg-[var(--color-surface)]">
                  {listedLabels.get(p.id) ?? p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleNew}
              className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors"
              title="Create New">
              <Plus size={16} />
            </button>
            <button
              type="button"
              onClick={handleDuplicate}
              className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors"
              title="Duplicate">
              <Copy size={16} />
            </button>
            {!localState.isDefault && (
              <button
                type="button"
                onClick={handleDelete}
                className="p-1 hover:bg-red-900/30 text-red-400 rounded-md transition-colors"
                title="Delete">
                <Trash2 size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => requestPresetChange(null)}
              className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="px-4 pb-3">
          <label
            htmlFor="inferenceCopyFrom"
            className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
            Copy from
          </label>
          <select
            id="inferenceCopyFrom"
            value=""
            disabled={copySources.length === 0}
            title="Copies sampling, tools, and the other settings onto this preset. Its name and model stay put. Save to keep the change."
            onChange={(e) => {
              const sourceId = e.target.value;
              if (sourceId) handleCopyFrom(sourceId);
            }}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-2 py-1.5 rounded-md text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-50">
            <option value="">
              {copySources.length === 0 ? "No other presets" : "Choose a preset…"}
            </option>
            {copySources.map((preset) => (
              <option key={preset.id} value={preset.id} className="bg-[var(--color-surface)]">
                {copyLabels.get(preset.id) ?? preset.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <div className="space-y-2">
          <label htmlFor="inferencePresetName" className="text-sm font-medium">
            Preset Name
          </label>
          <input
            id="inferencePresetName"
            type="text"
            value={localState.name || ""}
            onChange={(e) => updateField("name", e.target.value)}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md disabled:opacity-50"
          />
        </div>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Sampling
          </h3>

          <div className="space-y-1">
            <label htmlFor="tempRange" className="text-sm font-medium flex justify-between">
              <span>Temperature</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {(localState.temperature ?? 0.8).toFixed(2)}
              </span>
            </label>
            <input
              id="tempRange"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={localState.temperature ?? 0.8}
              onChange={(e) => updateField("temperature", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="topPRange" className="text-sm font-medium flex justify-between">
              <span>Top-P</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {(localState.topP ?? 0.95).toFixed(2)}
              </span>
            </label>
            <input
              id="topPRange"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={localState.topP ?? 0.95}
              onChange={(e) => updateField("topP", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="minPRange" className="text-sm font-medium flex justify-between">
              <span>Min-P</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {(localState.minP ?? 0.05).toFixed(2)}
              </span>
            </label>
            <input
              id="minPRange"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={localState.minP ?? 0.05}
              onChange={(e) => updateField("minP", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="topKRange" className="text-sm font-medium flex justify-between">
              <span>Top-K</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {localState.topK ?? 40}
              </span>
            </label>
            <input
              id="topKRange"
              type="range"
              min="1"
              max="100"
              step="1"
              value={localState.topK ?? 40}
              onChange={(e) => updateField("topK", parseInt(e.target.value, 10))}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="typicalPRange" className="text-sm font-medium flex justify-between">
              <span>Typical-P</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {(localState.typicalP ?? 1.0).toFixed(2)}
              </span>
            </label>
            <input
              id="typicalPRange"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={localState.typicalP ?? 1.0}
              onChange={(e) => updateField("typicalP", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Penalties
          </h3>

          <div className="space-y-1">
            <label
              htmlFor="repeatPenaltyRange"
              className="text-sm font-medium flex justify-between">
              <span>Repeat Penalty</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {(localState.repeatPenalty ?? 1.1).toFixed(2)}
              </span>
            </label>
            <input
              id="repeatPenaltyRange"
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              value={localState.repeatPenalty ?? 1.1}
              onChange={(e) => updateField("repeatPenalty", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="space-y-1 mt-2">
            <label htmlFor="repeatLastNInput" className="text-sm font-medium flex justify-between">
              <span>Repeat Last N Tokens</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {localState.repeatLastN ?? 64}
              </span>
            </label>
            <input
              id="repeatLastNInput"
              type="number"
              min="-1"
              step="1"
              value={localState.repeatLastN ?? 64}
              onChange={(e) => updateField("repeatLastN", parseInt(e.target.value, 10))}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
            />
          </div>

          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="space-y-1">
              <label
                htmlFor="presencePenaltyRange"
                className="text-sm font-medium flex justify-between">
                <span>Presence</span>
                <span className="text-[var(--color-text-muted)] font-mono">
                  {(localState.presencePenalty ?? 0).toFixed(1)}
                </span>
              </label>
              <input
                id="presencePenaltyRange"
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={localState.presencePenalty ?? 0}
                onChange={(e) => updateField("presencePenalty", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="frequencyPenaltyRange"
                className="text-sm font-medium flex justify-between">
                <span>Frequency</span>
                <span className="text-[var(--color-text-muted)] font-mono">
                  {(localState.frequencyPenalty ?? 0).toFixed(1)}
                </span>
              </label>
              <input
                id="frequencyPenaltyRange"
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={localState.frequencyPenalty ?? 0}
                onChange={(e) => updateField("frequencyPenalty", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--color-border)] mt-4">
            <h4 className="text-xs font-bold text-[var(--color-text-muted)] mb-2 uppercase">
              DRY Penalty
            </h4>

            <div className="space-y-1">
              <label htmlFor="dryMultiplier" className="text-sm font-medium flex justify-between">
                <span>Multiplier</span>
                <span className="text-[var(--color-text-muted)] font-mono">
                  {(localState.dryMultiplier ?? 0.0).toFixed(1)}
                </span>
              </label>
              <input
                id="dryMultiplier"
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={localState.dryMultiplier ?? 0.0}
                onChange={(e) => updateField("dryMultiplier", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="grid grid-cols-2 gap-4 mt-2">
              <div className="space-y-1">
                <label htmlFor="dryBase" className="text-sm font-medium">
                  Base
                </label>
                <input
                  id="dryBase"
                  type="number"
                  step="0.05"
                  value={localState.dryBase ?? 1.75}
                  onChange={(e) => updateField("dryBase", parseFloat(e.target.value))}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded text-xs"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="dryAllowedLength" className="text-sm font-medium">
                  Allowed Len
                </label>
                <NumberDraftInput
                  id="dryAllowedLength"
                  integer
                  min={0}
                  value={localState.dryAllowedLength ?? 2}
                  onCommit={(value) => updateField("dryAllowedLength", value ?? 2)}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded text-xs"
                />
              </div>
            </div>

            <div className="space-y-1 mt-2">
              <label htmlFor="dryPenaltyLastN" className="text-sm font-medium">
                Penalty Last N
              </label>
              <NumberDraftInput
                id="dryPenaltyLastN"
                integer
                min={0}
                value={localState.dryPenaltyLastN ?? 64}
                onCommit={(value) => updateField("dryPenaltyLastN", value ?? 64)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded text-xs"
              />
            </div>

            <div className="space-y-1 mt-2">
              <label htmlFor="drySequenceBreakers" className="text-sm font-medium">
                Sequence Breakers (JSON array)
              </label>
              <ParsedTextDraftInput
                id="drySequenceBreakers"
                committedText={JSON.stringify(
                  localState.drySequenceBreakers ?? ["\n", ":", '"', "*"],
                )}
                parse={parseSequenceBreakers}
                onCommit={(value) => updateField("drySequenceBreakers", value)}
                onValidityChange={setFieldValid}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded text-xs font-mono"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Dynamic Sampling
          </h3>

          <div className="space-y-2">
            <label htmlFor="mirostatSelect" className="text-sm font-medium">
              Mirostat Version
            </label>
            <select
              id="mirostatSelect"
              value={localState.mirostat ?? 0}
              onChange={(e) => updateField("mirostat", parseInt(e.target.value, 10) as 0 | 1 | 2)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1.5 rounded">
              <option value={0}>Off</option>
              <option value={1}>Version 1</option>
              <option value={2}>Version 2</option>
            </select>
          </div>

          {localState.mirostat !== 0 && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label htmlFor="mirostatTau" className="text-sm font-medium">
                  Tau
                </label>
                <input
                  id="mirostatTau"
                  type="number"
                  value={localState.mirostatTau ?? 5.0}
                  onChange={(e) => updateField("mirostatTau", parseFloat(e.target.value))}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="mirostatEta" className="text-sm font-medium">
                  Eta
                </label>
                <input
                  id="mirostatEta"
                  type="number"
                  value={localState.mirostatEta ?? 0.1}
                  onChange={(e) => updateField("mirostatEta", parseFloat(e.target.value))}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label htmlFor="dynaTempRange" className="text-sm font-medium">
                DynaTemp Range
              </label>
              <input
                id="dynaTempRange"
                type="number"
                step="0.1"
                value={localState.dynaTempRange ?? 0.0}
                onChange={(e) => updateField("dynaTempRange", parseFloat(e.target.value))}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="dynaTempExp" className="text-sm font-medium">
                Exp
              </label>
              <input
                id="dynaTempExp"
                type="number"
                step="0.1"
                value={localState.dynaTempExponent ?? 1.0}
                onChange={(e) => updateField("dynaTempExponent", parseFloat(e.target.value))}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--color-border)] mt-4">
            <h4 className="text-xs font-bold text-[var(--color-text-muted)] mb-2 uppercase">
              XTC Sampler
            </h4>
            <div className="space-y-1">
              <label htmlFor="xtcProbability" className="text-sm font-medium flex justify-between">
                <span>Probability</span>
                <span className="text-[var(--color-text-muted)] font-mono">
                  {(localState.xtcProbability ?? 0.0).toFixed(2)}
                </span>
              </label>
              <input
                id="xtcProbability"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={localState.xtcProbability ?? 0.0}
                onChange={(e) => updateField("xtcProbability", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
            <div className="space-y-1 mt-2">
              <label htmlFor="xtcThreshold" className="text-sm font-medium flex justify-between">
                <span>Threshold</span>
                <span className="text-[var(--color-text-muted)] font-mono">
                  {(localState.xtcThreshold ?? 0.1).toFixed(2)}
                </span>
              </label>
              <input
                id="xtcThreshold"
                type="range"
                min="0"
                max="0.5"
                step="0.01"
                value={localState.xtcThreshold ?? 0.1}
                onChange={(e) => updateField("xtcThreshold", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Limits
          </h3>

          <div className="space-y-2">
            <label htmlFor="maxTokensInput" className="text-sm font-medium">
              Max Tokens
            </label>
            <NumberDraftInput
              id="maxTokensInput"
              integer
              min={-1}
              value={localState.maxTokens ?? -1}
              onCommit={(value) => updateField("maxTokens", value ?? -1)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          <div className="space-y-2 mt-4">
            <label htmlFor="seedInput" className="text-sm font-medium">
              Seed (-1 = random)
            </label>
            <NumberDraftInput
              id="seedInput"
              integer
              value={localState.seed ?? -1}
              onCommit={(value) => updateField("seed", value ?? -1)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          <div className="space-y-2 mt-4">
            <label htmlFor="stopStringsInput" className="text-sm font-medium">
              Stop Strings (comma-separated)
            </label>
            <ParsedTextDraftInput
              id="stopStringsInput"
              committedText={formatStopStrings(localState.stopStrings)}
              parse={(raw) => ({ ok: true, value: parseStopStrings(raw) })}
              onCommit={(value) => updateField("stopStrings", value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          <div className="space-y-2 mt-4">
            <label
              htmlFor="contextOverflowPolicy"
              className="text-sm font-medium text-[var(--color-text-primary)]">
              Context Overflow Policy
            </label>
            <p className="text-xs text-[var(--color-text-muted)] leading-tight mb-2">
              Behavior when generated tokens exceed the context window.
              <strong className="block mt-1">
                Note: Rolling Window requires --context-shift enabled in Model Preset.
              </strong>
            </p>
            <select
              id="contextOverflowPolicy"
              value={localState.contextOverflowPolicy || "TruncateMiddle"}
              onChange={(e) =>
                updateField(
                  "contextOverflowPolicy",
                  e.target.value as InferencePreset["contextOverflowPolicy"],
                )
              }
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-sm rounded-md outline-none focus:border-[var(--color-accent)]">
              <option value="StopAtLimit">Stop At Limit</option>
              <option value="TruncateMiddle">Truncate Middle</option>
              <option value="RollingWindow">Rolling Window</option>
            </select>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center justify-between">
            <label htmlFor="structuredOutputEnabled">Structured Output</label>
            <input
              id="structuredOutputEnabled"
              type="checkbox"
              checked={!!localState.structuredOutput?.enabled}
              onChange={(e) =>
                updateField("structuredOutput", {
                  ...localState.structuredOutput,
                  enabled: e.target.checked,
                  schema: localState.structuredOutput?.schema || {},
                  grammar: localState.structuredOutput?.grammar,
                })
              }
              className="accent-[var(--color-accent)]"
            />
          </h3>

          {localState.structuredOutput?.enabled && (
            <fieldset
              className="border border-[var(--color-border)] rounded-md overflow-hidden"
              onBlur={() => {
                try {
                  const parsed = JSON.parse(schemaDraft);
                  updateField("structuredOutput", {
                    enabled: true,
                    schema: parsed,
                    grammar: undefined,
                  });
                } catch {
                  // keep the draft until it is valid JSON
                }
              }}>
              <CodeMirror
                value={schemaDraft}
                extensions={[json()]}
                theme={codeMirrorTheme}
                onChange={(val) => setSchemaDraft(val)}
                className="text-xs h-40"
              />
            </fieldset>
          )}
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center justify-between">
            <label
              htmlFor="thinkingEnabled"
              title="Passes enable_thinking = true/false to the Jinja chat template">
              Thinking / CoT
            </label>
            <input
              id="thinkingEnabled"
              type="checkbox"
              checked={localState.thinkingEnabled ?? true}
              onChange={(e) => updateField("thinkingEnabled", e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-2">
            Tag parsing is controlled by the active load preset. This toggle only controls whether
            `enable_thinking` is requested on subsequent generations.
          </p>
        </section>

        <section className="space-y-4">
          <h3
            className={`text-xs font-bold uppercase tracking-wider flex items-center justify-between ${
              toolsSupported
                ? "text-[var(--color-text-muted)]"
                : "text-[var(--color-text-muted)] opacity-50"
            }`}>
            <label
              htmlFor="toolsEnabled"
              title={
                toolsSupported
                  ? "Send selected tools on /v1/chat/completions when this preset is used"
                  : "The loaded model's chat template does not describe tools or replay tool_calls"
              }>
              Tools (Function Calling)
            </label>
            <input
              id="toolsEnabled"
              type="checkbox"
              checked={!!localState.toolCallsEnabled}
              disabled={toolsEnableLocked}
              onChange={(e) => updateField("toolCallsEnabled", e.target.checked)}
              className="accent-[var(--color-accent)] disabled:cursor-not-allowed"
            />
          </h3>
          {!toolsSupported && (
            <p className="text-xs text-[var(--color-text-muted)] leading-tight">
              The loaded model's Jinja chat template does not describe tools, so llama-server will
              not show them to the model. Load a tool-capable model, or paste a tool-calling
              template on the load preset.
            </p>
          )}

          {localState.toolCallsEnabled && (
            <div className="space-y-3">
              <p className="text-xs text-[var(--color-text-muted)] leading-tight">
                Tools are TypeScript modules executed by the LlamaForge server. Built-ins ship with
                the app. User tools are loaded from the project tools folder and
                ~/.llamaforge/tools. Each file must default-export an object with name, description,
                parameters, and execute.
              </p>
              {toolsPending && (
                <p className="text-xs text-[var(--color-text-muted)]">Loading tools…</p>
              )}
              {toolsError && (
                <p className="text-xs text-red-400">
                  Could not load the tool catalog. Tools already saved on this preset are still
                  listed below.
                </p>
              )}
              {catalogTools(toolsCatalog?.tools, localState.tools ?? []).map((tool) => {
                const enabled = (localState.tools ?? []).some((entry) => entry.name === tool.name);
                const inputId = `tool-${tool.name}`;
                return (
                  <label
                    key={tool.name}
                    htmlFor={inputId}
                    className="flex items-start gap-2 text-sm">
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => toggleTool(tool, e.target.checked)}
                      className="mt-1 accent-[var(--color-accent)]"
                    />
                    <span>
                      <span className="font-medium">{tool.name}</span>
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                        {tool.source === "user"
                          ? "User"
                          : tool.source === "builtin"
                            ? "Built-in"
                            : "Saved"}
                      </span>
                      <span className="block text-xs text-[var(--color-text-muted)]">
                        {tool.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] flex flex-col gap-2">
        <PresetSaveStatus message={saveMessage} error={saveError} />
        <button
          type="button"
          onClick={handleSave}
          className="flex-1 flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white p-2 rounded-lg hover:shadow-md active:scale-95 active:shadow-none transition-all disabled:opacity-50">
          <Save size={16} /> Save Changes
        </button>
      </div>
    </div>
  );
}
