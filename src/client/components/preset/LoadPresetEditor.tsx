/**
 * @packageDocumentation
 * Sidebar panel for editing model load presets (llama-server startup flags).
 * Includes hardware optimization, GGUF path selection, and Jinja template overrides.
 */

import { markdown } from "@codemirror/lang-markdown";
import type { LoadPreset, ModelLoadConfig } from "@shared/types.js";
import CodeMirror from "@uiw/react-codemirror";
import { ChevronDown, ChevronRight, Copy, Plus, Save, Trash2, X, Zap } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import {
  useCreateLoadPreset,
  useDeleteLoadPreset,
  useLoadPresets,
  useUpdateLoadPreset,
} from "../../queries";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { HardwareOptimizationModal } from "./HardwareOptimizationModal";

// Simple accordion component
function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-[var(--color-border)] rounded-md overflow-hidden bg-[var(--color-bg)]">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2 text-sm font-semibold bg-[var(--color-surface-elevated)] hover:bg-[var(--color-border)]">
        {title}
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {isOpen && <div className="p-3 space-y-3">{children}</div>}
    </div>
  );
}

/**
 * Component for managing and editing model load presets.
 * Organized into accordion sections for Core, Batching, Memory, KV Cache, and RoPE.
 *
 * @returns React functional component.
 */
export function LoadPresetEditor() {
  const { setRightPanelView, activePresetId } = useUiStore();
  const { models } = useAppStore();
  const { data: presets } = useLoadPresets();
  const createMut = useCreateLoadPreset();
  const updateMut = useUpdateLoadPreset();
  const deleteMut = useDeleteLoadPreset();

  const activePreset = presets?.find((p) => p.id === activePresetId) || presets?.[0];

  const [localState, setLocalState] = useState<Partial<LoadPreset> | null>(null);
  const [showOptimization, setShowOptimization] = useState(false);

  useEffect(() => {
    if (activePreset) {
      setLocalState({ ...activePreset, config: { ...activePreset.config } });
    }
  }, [activePreset]);

  if (!localState?.config)
    return <div className="w-80 shrink-0 bg-[var(--color-surface)] border-l" />;

  const matchingModel = models.find(
    (m) => m.primaryPath === localState.modelPath || m.primaryPath === localState.config?.modelPath,
  );
  const defaultTemplate = matchingModel?.metadata?.chatTemplate || "";
  const displayTemplate = localState.chatTemplateOverride || defaultTemplate;

  const updatePresetField = <K extends keyof LoadPreset>(k: K, v: LoadPreset[K]) => {
    setLocalState((prev) => (prev ? { ...prev, [k]: v } : null));
  };

  const updateConfigField = <K extends keyof ModelLoadConfig>(k: K, v: ModelLoadConfig[K]) => {
    setLocalState((prev) =>
      prev ? { ...prev, config: { ...(prev.config as ModelLoadConfig), [k]: v } } : null,
    );
  };

  const handleApplyOptimization = (optimizedConfig: Partial<ModelLoadConfig>) => {
    setLocalState((prev) => {
      if (!prev?.config) return prev;
      return {
        ...prev,
        config: {
          ...prev.config,
          ...optimizedConfig,
        } as ModelLoadConfig,
      };
    });
    setShowOptimization(false);
  };

  const handleSave = () => {
    if (!localState.id) return;
    updateMut.mutate({ id: localState.id, updates: localState });
  };

  const handleDuplicate = () => {
    if (!localState) return;
    const newPreset: LoadPreset = {
      ...(localState as LoadPreset),
      id: crypto.randomUUID(),
      name: `${localState.name} (Copy)`,
      isDefault: false,
      isReadonly: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("loadPreset", newPreset.id);
  };

  const handleNew = () => {
    const newPreset: LoadPreset = {
      id: crypto.randomUUID(),
      name: "New Load Preset",
      modelPath: "",
      isDefault: false,
      isReadonly: false,
      config: {
        modelPath: "",
        contextSize: 4096,
        contextShift: false,
        gpuLayers: -1,
        threads: 8,
        batchSize: 512,
        microBatchSize: 128,
        ropeScaling: "none",
        ropeFreqBase: 0,
        ropeFreqScale: 0,
        kvCacheTypeK: "f16",
        kvCacheTypeV: "f16",
        mlock: false,
        noMmap: false,
        flashAttention: true,
        imageMaxTokens: 280,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("loadPreset", newPreset.id);
  };

  const handleDelete = () => {
    if (!localState.id || localState.isReadonly) return;
    deleteMut.mutate(localState.id);
    setRightPanelView("loadPreset", presets?.find((p) => p.id !== localState.id)?.id);
  };

  const config = localState.config;
  const isReadonly = localState.isReadonly;

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-[400px] shadow-xl overflow-hidden shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)] gap-2">
        <div className="flex flex-col flex-1 min-w-0">
          <h2 className="font-semibold text-lg flex items-center gap-2 truncate">Load Preset</h2>
          <select
            value={activePreset?.id || ""}
            onChange={(e) => setRightPanelView("loadPreset", e.target.value)}
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
          {!isReadonly && (
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

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="space-y-2">
          <label htmlFor="loadPresetName" className="text-sm font-medium">
            Preset Name
          </label>
          <input
            id="loadPresetName"
            type="text"
            value={localState.name || ""}
            onChange={(e) => updatePresetField("name", e.target.value)}
            disabled={isReadonly}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md disabled:opacity-50 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="modelPath"
            className="text-sm font-medium"
            title="Path to the primary GGUF model file">
            Primary Model Path (GGUF)
          </label>
          <input
            id="modelPath"
            type="text"
            value={config.modelPath || ""}
            onChange={(e) => updateConfigField("modelPath", e.target.value)}
            disabled={isReadonly}
            className="w-full font-mono bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md disabled:opacity-50 text-xs"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="mmProjPath" className="text-sm font-medium">
            MMProj Path (Optional Vision)
          </label>
          <input
            id="mmProjPath"
            type="text"
            value={config.mmProjPath || ""}
            onChange={(e) => updateConfigField("mmProjPath", e.target.value)}
            disabled={isReadonly}
            placeholder="Auto-detected if blank"
            className="w-full font-mono bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md disabled:opacity-50 text-xs"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowOptimization(true)}
          className="w-full flex items-center justify-center gap-2 p-2 border border-[var(--color-accent)] text-[var(--color-accent)] rounded-lg hover:bg-[var(--color-surface-elevated)] transition-all text-sm font-medium disabled:opacity-50"
          disabled={isReadonly}>
          <Zap size={16} /> Optimize for my hardware
        </button>

        {showOptimization && (
          <HardwareOptimizationModal
            modelPath={config.modelPath}
            onClose={() => setShowOptimization(false)}
            onApply={handleApplyOptimization}
          />
        )}

        <Accordion title="Core Limits" defaultOpen>
          <div className="space-y-1">
            <label htmlFor="gpuLayers" className="text-xs font-medium flex justify-between">
              <span>GPU Layers (-1 = all)</span>
              <span className="text-[var(--color-text-muted)] font-mono">
                {config.gpuLayers ?? -1}
              </span>
            </label>
            <input
              id="gpuLayers"
              type="range"
              min="-1"
              max="99"
              step="1"
              value={config.gpuLayers ?? -1}
              onChange={(e) => updateConfigField("gpuLayers", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ctxSize" className="text-xs font-medium flex justify-between">
              <span>Context Size (ctx-size)</span>
            </label>
            <input
              id="ctxSize"
              type="number"
              min="512"
              step="512"
              value={config.contextSize ?? 4096}
              onChange={(e) => updateConfigField("contextSize", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
            />
          </div>
          <div className="space-y-1 flex items-center justify-between">
            <label htmlFor="ctxShift" className="text-xs font-medium flex justify-between">
              <span>Context Shift (--context-shift)</span>
            </label>
            <input
              id="ctxShift"
              type="checkbox"
              checked={config.contextShift ?? false}
              onChange={(e) => updateConfigField("contextShift", e.target.checked)}
              disabled={isReadonly}
              className="mt-1"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="imageMaxTokens" className="text-xs font-medium flex justify-between">
              <span>VIR max tokens (--image-max-tokens)</span>
            </label>
            <select
              id="imageMaxTokens"
              value={config.imageMaxTokens ?? 280}
              onChange={(e) => updateConfigField("imageMaxTokens", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm">
              <option value={70}>70</option>
              <option value={140}>140</option>
              <option value={280}>280</option>
              <option value={560}>560</option>
              <option value={1120}>1120</option>
            </select>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Applies at model load time as `--image-min-tokens 70 --image-max-tokens {"<value>"}`.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="threads" className="text-xs font-medium flex justify-between">
              <span>Threads</span>
            </label>
            <input
              id="threads"
              type="number"
              min="1"
              step="1"
              value={config.threads ?? 4}
              onChange={(e) => updateConfigField("threads", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
            />
          </div>
        </Accordion>

        <Accordion title="Batching">
          <div className="space-y-2 text-xs">
            <label htmlFor="batchSize" className="font-medium flex justify-between">
              <span>Batch Size</span>
            </label>
            <input
              id="batchSize"
              type="number"
              value={config.batchSize ?? 512}
              onChange={(e) => updateConfigField("batchSize", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] px-2 py-1 border border-[var(--color-border)] rounded"
            />
            <label htmlFor="microBatchSize" className="font-medium flex justify-between mt-2">
              <span>Micro Batch Size</span>
            </label>
            <input
              id="microBatchSize"
              type="number"
              value={config.microBatchSize ?? 512}
              onChange={(e) => updateConfigField("microBatchSize", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] px-2 py-1 border border-[var(--color-border)] rounded"
            />
          </div>
        </Accordion>

        <Accordion title="Memory & KV Cache">
          <div className="space-y-2 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!config.mlock}
                onChange={(e) => updateConfigField("mlock", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">mlock (lock in RAM)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!config.noMmap}
                onChange={(e) => updateConfigField("noMmap", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">no-mmap (do not memory-map)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!config.flashAttention}
                onChange={(e) => updateConfigField("flashAttention", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">Flash Attention (if supported)</span>
            </label>
            <div className="mt-2 text-xs border-t border-[var(--color-border)] pt-2 space-y-2">
              <label htmlFor="kvCacheK" className="block font-medium">
                KV Cache Type (K)
              </label>
              <select
                id="kvCacheK"
                value={config.kvCacheTypeK ?? "f16"}
                onChange={(e) =>
                  updateConfigField(
                    "kvCacheTypeK",
                    e.target.value as "f16" | "f32" | "q8_0" | "q4_0",
                  )
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
                <option value="f16">f16</option>
                <option value="f32">f32</option>
                <option value="q8_0">q8_0</option>
                <option value="q4_0">q4_0</option>
              </select>
              <label htmlFor="kvCacheV" className="block font-medium">
                KV Cache Type (V)
              </label>
              <select
                id="kvCacheV"
                value={config.kvCacheTypeV ?? "f16"}
                onChange={(e) =>
                  updateConfigField(
                    "kvCacheTypeV",
                    e.target.value as "f16" | "f32" | "q8_0" | "q4_0",
                  )
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
                <option value="f16">f16</option>
                <option value="f32">f32</option>
                <option value="q8_0">q8_0</option>
                <option value="q4_0">q4_0</option>
              </select>
            </div>
          </div>
        </Accordion>

        <Accordion title="RoPE Scaling">
          <div className="space-y-2 text-xs">
            <label htmlFor="ropeScaling" className="block font-medium">
              RoPE Scaling
            </label>
            <select
              id="ropeScaling"
              value={config.ropeScaling ?? "none"}
              onChange={(e) =>
                updateConfigField("ropeScaling", e.target.value as "none" | "linear" | "yarn")
              }
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
              <option value="none">none</option>
              <option value="linear">linear</option>
              <option value="yarn">yarn</option>
            </select>
            <label htmlFor="ropeFreqBase" className="block font-medium mt-2">
              RoPE Freq Base
            </label>
            <input
              id="ropeFreqBase"
              type="number"
              value={config.ropeFreqBase || 0}
              onChange={(e) => updateConfigField("ropeFreqBase", parseFloat(e.target.value))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
            />
            <label htmlFor="ropeFreqScale" className="block font-medium mt-2">
              RoPE Freq Scale
            </label>
            <input
              id="ropeFreqScale"
              type="number"
              step="0.1"
              value={config.ropeFreqScale || 1.0}
              onChange={(e) => updateConfigField("ropeFreqScale", parseFloat(e.target.value))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
            />
          </div>
        </Accordion>

        <Accordion title="Advanced (NUMA, Tensor Split)">
          <div className="space-y-2 text-xs">
            <label htmlFor="numa" className="block font-medium">
              NUMA
            </label>
            <select
              id="numa"
              value={config.numa ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                updateConfigField(
                  "numa",
                  val ? (val as "distribute" | "isolate" | "numactl") : undefined,
                );
              }}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
              <option value="">(disabled)</option>
              <option value="distribute">distribute</option>
              <option value="isolate">isolate</option>
              <option value="numactl">numactl</option>
            </select>
            <label htmlFor="mainGpu" className="block font-medium mt-2">
              Main GPU
            </label>
            <input
              id="mainGpu"
              type="number"
              value={config.mainGpu ?? ""}
              onChange={(e) =>
                updateConfigField(
                  "mainGpu",
                  e.target.value ? parseInt(e.target.value, 10) : undefined,
                )
              }
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
              placeholder="Default"
            />
            <label htmlFor="tensorSplit" className="block font-medium mt-2">
              Tensor Split (comma-separated)
            </label>
            <input
              id="tensorSplit"
              type="text"
              value={config.tensorSplit?.join(",") ?? ""}
              onChange={(e) =>
                updateConfigField(
                  "tensorSplit",
                  e.target.value
                    ? e.target.value.split(",").map((n) => parseFloat(n.trim()))
                    : undefined,
                )
              }
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
              placeholder="e.g. 3,2"
            />
          </div>
        </Accordion>

        <div className="pt-2">
          <label className="text-sm font-medium mb-2 flex items-center justify-between">
            <span>Jinja Chat Template</span>
            <button
              type="button"
              disabled={isReadonly}
              onClick={() => updatePresetField("chatTemplateOverride", undefined)}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] disabled:opacity-50">
              Reset Default
            </button>
          </label>
          <div className="border border-[var(--color-border)] rounded-md overflow-hidden min-h-[120px]">
            <CodeMirror
              value={displayTemplate}
              extensions={[markdown()]}
              theme="dark"
              readOnly={!!isReadonly}
              onChange={(val) => updatePresetField("chatTemplateOverride", val)}
              className="text-xs"
              placeholder="Leave blank to use GGUF metadata default"
            />
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] flex space-x-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isReadonly}
          className="flex-1 flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white p-2 rounded-lg hover:shadow-md active:scale-95 active:shadow-none transition-all disabled:opacity-50">
          <Save size={16} /> Save Changes
        </button>
      </div>
    </div>
  );
}
