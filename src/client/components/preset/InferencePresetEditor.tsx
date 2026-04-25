/**
 * @packageDocumentation
 * Sidebar panel for editing inference presets (sampling, dynamic penalties, structured output, and tools).
 */

import { json } from "@codemirror/lang-json";
import type { InferencePreset } from "@shared/types.js";
import CodeMirror from "@uiw/react-codemirror";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useCreateInferencePreset,
  useDeleteInferencePreset,
  useInferencePresets,
  useUpdateInferencePreset,
} from "../../queries";
import { useUiStore } from "../../uiStore";

/**
 * Component for managing and editing inference presets.
 * Includes sliders for sampling params, JSON editors for tools/schema, and lifecycle actions (new, duplicate, delete).
 *
 * @returns React functional component.
 */
export function InferencePresetEditor() {
  const { setRightPanelView, activePresetId } = useUiStore();
  const { data: presets } = useInferencePresets();
  const createMut = useCreateInferencePreset();
  const updateMut = useUpdateInferencePreset();
  const deleteMut = useDeleteInferencePreset();

  const activePreset = presets?.find((p) => p.id === activePresetId) || presets?.[0];

  const [localState, setLocalState] = useState<Partial<InferencePreset> | null>(null);

  useEffect(() => {
    if (activePreset) {
      setLocalState(activePreset);
    }
  }, [activePreset]);

  if (!localState) return <div className="w-80 shrink-0 bg-[var(--color-surface)] border-l" />;

  const updateField = <K extends keyof InferencePreset>(k: K, v: InferencePreset[K]) => {
    setLocalState((prev) => (prev ? { ...prev, [k]: v } : null));
  };

  const handleSave = () => {
    if (!localState.id) return;
    updateMut.mutate({ id: localState.id, updates: localState });
  };

  const handleDuplicate = () => {
    if (!localState) return;
    const newPreset: InferencePreset = {
      ...(localState as InferencePreset),
      id: crypto.randomUUID(),
      name: `${localState.name} (Copy)`,
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("inferencePreset", newPreset.id);
  };

  const handleNew = () => {
    const newPreset: InferencePreset = {
      id: crypto.randomUUID(),
      name: "New Inference Preset",
      isDefault: false,
      temperature: 0.8,
      topK: 40,
      topP: 0.95,
      minP: 0.05,
      repeatPenalty: 1.1,
      repeatLastN: 64,
      tfsZ: 1.0,
      typicalP: 1.0,
      presencePenalty: 0.0,
      frequencyPenalty: 0.0,
      mirostat: 0,
      mirostatTau: 5.0,
      mirostatEta: 0.1,
      dynaTempRange: 0.0,
      dynaTempExponent: 1.0,
      seed: -1,
      maxTokens: -1,
      stopStrings: [],
      toolCallsEnabled: false,
      tools: [],
      structuredOutput: undefined,
      contextOverflowPolicy: "TruncateMiddle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("inferencePreset", newPreset.id);
  };

  const handleDelete = () => {
    if (!localState.id || localState.isDefault) return;
    deleteMut.mutate(localState.id);
    setRightPanelView("inferencePreset", presets?.find((p) => p.id !== localState.id)?.id);
  };

  const structuredOutputJson = localState.structuredOutput?.schema
    ? JSON.stringify(localState.structuredOutput.schema, null, 2)
    : "{}";

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-96 shadow-xl overflow-hidden shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)] gap-2">
        <div className="flex flex-col flex-1 min-w-0">
          <h2 className="font-semibold text-lg flex items-center gap-2 truncate">
            Inference Preset
          </h2>
          <select
            value={activePreset?.id || ""}
            onChange={(e) => setRightPanelView("inferencePreset", e.target.value)}
            className="text-xs bg-transparent border-none text-[var(--color-text-muted)] outline-none focus:text-[var(--color-text-primary)] w-full truncate">
            {presets?.map((p) => (
              <option key={p.id} value={p.id} className="bg-[var(--color-surface)]">
                {p.name} {p.isDefault ? "(Default)" : ""}
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
            onClick={() => setRightPanelView(null)}
            className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors">
            <X size={18} />
          </button>
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
            disabled={localState.isDefault}
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

          <div className="space-y-1">
            <label htmlFor="tfsZRange" className="text-sm font-medium flex justify-between">
              <span>TFS-Z</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {(localState.tfsZ ?? 1.0).toFixed(2)}
              </span>
            </label>
            <input
              id="tfsZRange"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={localState.tfsZ ?? 1.0}
              onChange={(e) => updateField("tfsZ", parseFloat(e.target.value))}
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

          <div className="grid grid-cols-2 gap-4">
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
                type="number"
                step="0.1"
                value={localState.dynaTempExponent ?? 1.0}
                onChange={(e) => updateField("dynaTempExponent", parseFloat(e.target.value))}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
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
            <input
              id="maxTokensInput"
              type="number"
              min="-1"
              value={localState.maxTokens ?? -1}
              onChange={(e) => updateField("maxTokens", parseInt(e.target.value, 10))}
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
              value={localState.contextOverflowPolicy || "StopAtLimit"}
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
            <div className="border border-[var(--color-border)] rounded-md overflow-hidden">
              <CodeMirror
                value={structuredOutputJson}
                extensions={[json()]}
                theme="dark"
                onChange={(val) => {
                  try {
                    const parsed = JSON.parse(val);
                    updateField("structuredOutput", {
                      enabled: true,
                      schema: parsed,
                      grammar: undefined,
                    });
                  } catch {
                    // ignore parse errors while typing
                  }
                }}
                className="text-xs h-40"
              />
            </div>
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

          <div className="pt-1 pb-2 space-y-2">
            <div className="text-xs font-bold text-[var(--color-text-muted)] tracking-wider">
              Thinking Tag Overrides
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label
                  htmlFor="thinkingOpenTagInput"
                  className="block mb-1 text-[var(--color-text-muted)]">
                  Open Tag
                </label>
                <input
                  id="thinkingOpenTagInput"
                  type="text"
                  value={localState.thinkingTagOverride?.openTag || ""}
                  disabled={localState.isDefault}
                  onChange={(e) =>
                    updateField("thinkingTagOverride", {
                      openTag: e.target.value,
                      closeTag: localState.thinkingTagOverride?.closeTag || "</think>",
                      enableToken: localState.thinkingTagOverride?.enableToken,
                    })
                  }
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1.5 rounded font-mono"
                  placeholder="<think>"
                />
              </div>
              <div>
                <label
                  htmlFor="thinkingCloseTagInput"
                  className="block mb-1 text-[var(--color-text-muted)]">
                  Close Tag
                </label>
                <input
                  id="thinkingCloseTagInput"
                  type="text"
                  value={localState.thinkingTagOverride?.closeTag || ""}
                  disabled={localState.isDefault}
                  onChange={(e) =>
                    updateField("thinkingTagOverride", {
                      openTag: localState.thinkingTagOverride?.openTag || "<think>",
                      closeTag: e.target.value,
                      enableToken: localState.thinkingTagOverride?.enableToken,
                    })
                  }
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1.5 rounded font-mono"
                  placeholder="</think>"
                />
              </div>
              <div className="col-span-2">
                <label
                  htmlFor="thinkingEnableTokenInput"
                  className="block mb-1 text-[var(--color-text-muted)]">
                  Enable Token (Fallback injected to sys prompt)
                </label>
                <input
                  id="thinkingEnableTokenInput"
                  type="text"
                  value={localState.thinkingTagOverride?.enableToken || ""}
                  disabled={localState.isDefault}
                  onChange={(e) =>
                    updateField("thinkingTagOverride", {
                      openTag: localState.thinkingTagOverride?.openTag || "<think>",
                      closeTag: localState.thinkingTagOverride?.closeTag || "</think>",
                      enableToken: e.target.value,
                    })
                  }
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1.5 rounded font-mono"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center justify-between">
            <label htmlFor="toolsEnabled">Tools (Function Calling)</label>
            <input
              id="toolsEnabled"
              type="checkbox"
              checked={!!localState.toolCallsEnabled}
              onChange={(e) => updateField("toolCallsEnabled", e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
          </h3>

          {localState.toolCallsEnabled && (
            <div className="border border-[var(--color-border)] rounded-md overflow-hidden">
              <CodeMirror
                value={localState.tools ? JSON.stringify(localState.tools, null, 2) : "[\n  \n]"}
                extensions={[json()]}
                theme="dark"
                onChange={(val) => {
                  try {
                    const parsed = JSON.parse(val);
                    if (Array.isArray(parsed)) {
                      updateField("tools", parsed);
                    }
                  } catch {
                    // ignore parse errors
                  }
                }}
                className="text-xs min-h-[160px]"
              />
            </div>
          )}
        </section>
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] flex space-x-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={localState.isDefault}
          className="flex-1 flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white p-2 rounded-lg hover:shadow-md transition-all disabled:opacity-50">
          <Save size={16} /> Save Changes
        </button>
      </div>
    </div>
  );
}
