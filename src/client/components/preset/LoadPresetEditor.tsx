/**
 * @packageDocumentation
 * Sidebar panel for editing model load presets (llama-server startup flags).
 * Includes hardware optimization, GGUF path selection, and Jinja template overrides.
 */

import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { ChevronDown, ChevronRight, Copy, Plus, Save, Trash2, X, Zap } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  clampVideoFps,
  createDefaultLoadConfig,
  DEFAULT_VIDEO_FPS,
  MAX_VIDEO_FPS,
  MIN_VIDEO_FPS,
} from "../../../shared/defaults";
import {
  applyImageTokenBatchFloor,
  DEFAULT_IMAGE_MAX_TOKENS,
  DEFAULT_IMAGE_MIN_TOKENS,
  IMAGE_MAX_TOKEN_OPTIONS,
  minUbatchForImageTokens,
} from "../../../shared/imageTokens";
import { analyzeLoadPresetChatTemplate } from "../../../shared/templateCapabilities";
import { detectThinkingConfig } from "../../../shared/thinkingTags";
import type { LoadPreset, ModelEntry, ModelLoadConfig } from "../../../shared/types";
import {
  useCreateLoadPreset,
  useDeleteLoadPreset,
  useLoadPresets,
  useUpdateLoadPreset,
} from "../../queries";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { HardwareOptimizationModal } from "./HardwareOptimizationModal";

function detectThinkingTagOverride(architecture?: string) {
  return detectThinkingConfig(architecture);
}

/**
 * Returns the directory prefix of a model path, handling both POSIX and Windows separators.
 *
 * @param primaryPath - Absolute or relative model file path.
 * @returns Directory prefix including the trailing separator, or an empty string.
 */
function modelDirectoryPrefix(primaryPath: string): string {
  const slash = Math.max(primaryPath.lastIndexOf("/"), primaryPath.lastIndexOf("\\"));
  return slash >= 0 ? primaryPath.slice(0, slash + 1) : "";
}

/**
 * Returns the filename component of a path, handling both POSIX and Windows separators.
 *
 * @param filePath - Absolute or relative file path.
 * @returns The last path segment.
 */
function fileNameFromPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

/**
 * Computes which speculative decoding modes are available for a given model.
 *
 * Draft companions are omitted from the scanned catalog (like mmproj files).
 * `gemma4-assistant` companions require `--spec-type draft-mtp`, not `draft-simple`.
 *
 * @param model - The primary model entry (may be undefined).
 * @param allModels - Full list of scanned models.
 * @returns Flags indicating which speculative modes the companion supports.
 */
function getSpeculativeDecodingAvailability(
  model: ModelEntry | undefined,
  allModels: ModelEntry[],
): {
  draftModel: boolean;
  mtp: boolean;
  detectedDraftPath: string;
  detectedSpecType: ModelEntry["draftSpecType"];
} {
  if (!model) {
    return { draftModel: false, mtp: false, detectedDraftPath: "", detectedSpecType: undefined };
  }
  const detectedDraftPath = model.draftModelPath?.trim() ?? "";
  const detectedSpecType = model.draftSpecType;
  const modelDir = modelDirectoryPrefix(model.primaryPath);
  const siblingDraft =
    modelDir.length > 0 &&
    allModels.some(
      (entry) =>
        entry.metadata?.isDraftModel &&
        entry.primaryPath !== model.primaryPath &&
        entry.primaryPath.startsWith(modelDir),
    );
  const hasAttachedMtp = detectedSpecType === "draft-mtp" && Boolean(detectedDraftPath);
  const hasMtpInName = model.modelName?.toLowerCase().includes("mtp") ?? false;
  const hasSimpleDraft =
    (Boolean(detectedDraftPath) && detectedSpecType === "draft-simple") ||
    (Boolean(detectedDraftPath) && !detectedSpecType) ||
    siblingDraft;
  return {
    draftModel: hasSimpleDraft && !hasAttachedMtp,
    mtp: hasAttachedMtp || hasMtpInName,
    detectedDraftPath,
    detectedSpecType,
  };
}

/**
 * Renders a collapsible section used to group preset editor controls.
 *
 * @param props - Accordion props including the title, child content, and default open state.
 * @returns The rendered accordion section.
 */
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
  const models = useAppStore((s) => s.models);
  const { data: presets } = useLoadPresets();
  const createMut = useCreateLoadPreset();
  const updateMut = useUpdateLoadPreset();
  const deleteMut = useDeleteLoadPreset();

  const activePreset = presets?.find((p) => p.id === activePresetId) || presets?.[0];

  const [localState, setLocalState] = useState<Partial<LoadPreset> | null>(null);
  const [showOptimization, setShowOptimization] = useState(false);

  useEffect(() => {
    if (!activePreset) return;
    setLocalState((prev) =>
      prev?.id === activePreset.id ? prev : { ...activePreset, config: { ...activePreset.config } },
    );
  }, [activePreset]);

  useEffect(() => {
    const config = localState?.config;
    if (!config) return;
    const matching = models.find(
      (m) => m.primaryPath === config.modelPath || m.primaryPath === localState.modelPath,
    );
    const availability = getSpeculativeDecodingAvailability(matching, models);
    const currentType = config.specType ?? "off";
    if (currentType !== "draft-mtp" || availability.mtp) return;
    setLocalState((prev) =>
      prev?.config ? { ...prev, config: { ...prev.config, specType: "off" } } : prev,
    );
  }, [localState?.config, localState?.modelPath, models]);

  const templateCapabilities = useMemo(() => {
    const matching = models.find(
      (m) =>
        m.primaryPath === localState?.modelPath || m.primaryPath === localState?.config?.modelPath,
    );
    return analyzeLoadPresetChatTemplate(
      localState?.chatTemplateOverride,
      matching?.metadata?.chatTemplate,
    );
  }, [
    localState?.chatTemplateOverride,
    localState?.config?.modelPath,
    localState?.modelPath,
    models,
  ]);

  if (!localState?.config)
    return <div className="w-80 shrink-0 bg-[var(--color-surface)] border-l" />;

  const matchingModel = models.find(
    (m) => m.primaryPath === localState.modelPath || m.primaryPath === localState.config?.modelPath,
  );
  const defaultTemplate = matchingModel?.metadata?.chatTemplate || "";
  const displayTemplate = localState.chatTemplateOverride ?? defaultTemplate;

  /**
   * Updates a top-level load preset field within local editor state.
   *
   * @param k - Field name to update.
   * @param v - New field value.
   * @returns No return value.
   */
  const updatePresetField = <K extends keyof LoadPreset>(k: K, v: LoadPreset[K]) => {
    setLocalState((prev) => (prev ? { ...prev, [k]: v } : null));
  };

  /**
   * Updates a nested load configuration field within local editor state.
   *
   * @param k - Load config field name to update.
   * @param v - New load config value.
   * @returns No return value.
   */
  const updateConfigField = <K extends keyof ModelLoadConfig>(k: K, v: ModelLoadConfig[K]) => {
    setLocalState((prev) =>
      prev ? { ...prev, config: { ...(prev.config as ModelLoadConfig), [k]: v } } : null,
    );
  };

  /**
   * Applies the optimizer's suggested configuration values to the current preset.
   *
   * @param optimizedConfig - Partial load configuration returned by the hardware optimizer.
   * @returns No return value.
   */
  const handleApplyOptimization = (optimizedConfig: Partial<ModelLoadConfig>) => {
    setLocalState((prev) => {
      if (!prev?.config) return prev;
      const merged = { ...prev.config, ...optimizedConfig } as ModelLoadConfig;
      const floored = applyImageTokenBatchFloor(
        merged.batchSize,
        merged.microBatchSize,
        merged.imageMaxTokens,
        matchingModel?.metadata?.architecture,
      );
      return {
        ...prev,
        config: {
          ...merged,
          ...floored,
        },
      };
    });
    setShowOptimization(false);
  };

  /**
   * Persists the currently edited load preset.
   *
   * @returns No return value.
   */
  const handleSave = () => {
    if (!localState.id) return;
    const preserveThinking = templateCapabilities?.hasPreserveThinking
      ? (localState.preserveThinking ?? templateCapabilities.preserveThinkingDefault ?? false)
      : false;
    updateMut.mutate({ id: localState.id, updates: { ...localState, preserveThinking } });
  };

  /**
   * Duplicates the current load preset and opens the clone for editing.
   *
   * @returns No return value.
   */
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

  /**
   * Creates a new load preset seeded with baseline llama-server defaults.
   *
   * @returns No return value.
   */
  const handleNew = () => {
    const newPreset: LoadPreset = {
      id: crypto.randomUUID(),
      name: "New Load Preset",
      modelPath: "",
      isDefault: false,
      isReadonly: false,
      config: createDefaultLoadConfig(""),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("loadPreset", newPreset.id);
  };

  /**
   * Deletes the currently selected mutable load preset.
   *
   * @returns No return value.
   */
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
            onClick={() => setRightPanelView("settings")}
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
            onChange={(e) => {
              updateConfigField("modelPath", e.target.value);
              updatePresetField("modelPath", e.target.value);
            }}
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
              value={config.imageMaxTokens ?? DEFAULT_IMAGE_MAX_TOKENS}
              onChange={(e) => {
                const imageMaxTokens = parseInt(e.target.value, 10);
                setLocalState((prev) => {
                  if (!prev?.config) return prev;
                  const existing = prev.config;
                  const floored = applyImageTokenBatchFloor(
                    existing.batchSize,
                    existing.microBatchSize,
                    imageMaxTokens,
                    matchingModel?.metadata?.architecture,
                  );
                  const imageMinTokens = Math.min(
                    existing.imageMinTokens ?? DEFAULT_IMAGE_MIN_TOKENS,
                    imageMaxTokens,
                  );
                  return {
                    ...prev,
                    config: { ...existing, imageMaxTokens, imageMinTokens, ...floored },
                  };
                });
              }}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm">
              {IMAGE_MAX_TOKEN_OPTIONS.map((budget) => (
                <option key={budget} value={budget}>
                  {budget}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Applied at model load as `--image-max-tokens{" "}
              {config.imageMaxTokens ?? DEFAULT_IMAGE_MAX_TOKENS}` with `--image-min-tokens{" "}
              {config.imageMinTokens ?? DEFAULT_IMAGE_MIN_TOKENS}`. For Gemma 4 only, micro-batch
              (`--ubatch-size`) is raised to at least{" "}
              {minUbatchForImageTokens(config.imageMaxTokens ?? DEFAULT_IMAGE_MAX_TOKENS)} so
              non-causal vision attention satisfies {"n_ubatch >= n_tokens"}. Other architectures
              keep the configured ubatch.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="imageMinTokens" className="text-xs font-medium flex justify-between">
              <span>VIR min tokens (--image-min-tokens)</span>
            </label>
            <input
              id="imageMinTokens"
              type="number"
              min={1}
              max={config.imageMaxTokens ?? DEFAULT_IMAGE_MAX_TOKENS}
              step="1"
              value={config.imageMinTokens ?? DEFAULT_IMAGE_MIN_TOKENS}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (!Number.isFinite(parsed)) return;
                const maxBudget = config.imageMaxTokens ?? DEFAULT_IMAGE_MAX_TOKENS;
                updateConfigField("imageMinTokens", Math.max(1, Math.min(parsed, maxBudget)));
              }}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="videoFps" className="text-xs font-medium flex justify-between">
              <span>Video FPS (--video-fps)</span>
            </label>
            <input
              id="videoFps"
              type="number"
              min={MIN_VIDEO_FPS}
              max={MAX_VIDEO_FPS}
              step="0.1"
              value={config.videoFps ?? DEFAULT_VIDEO_FPS}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateConfigField("videoFps", clampVideoFps(parsed));
              }}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
            />
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Applied at model load as `--video-fps {config.videoFps ?? DEFAULT_VIDEO_FPS}`.
              llama.cpp samples video attachments at this rate (default 4). Higher values send more
              frames and use more context.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="threads" className="text-xs font-medium flex justify-between">
              <span>Threads (-1 = auto)</span>
            </label>
            <input
              id="threads"
              type="number"
              min="-1"
              step="1"
              value={config.threads ?? -1}
              onChange={(e) => updateConfigField("threads", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="threadsBatch" className="text-xs font-medium flex justify-between">
              <span>Threads Batch (-1 = auto)</span>
            </label>
            <input
              id="threadsBatch"
              type="number"
              min="-1"
              step="1"
              value={config.threadsBatch ?? config.threads ?? -1}
              onChange={(e) => updateConfigField("threadsBatch", parseInt(e.target.value, 10))}
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
              value={config.batchSize ?? 2048}
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
            <label className="flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                checked={config.contBatching ?? true}
                onChange={(e) => updateConfigField("contBatching", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">Continuous Batching</span>
            </label>
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
                checked={config.kvUnified ?? true}
                onChange={(e) => updateConfigField("kvUnified", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">Unified KV Cache</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.swaFull ?? false}
                onChange={(e) => updateConfigField("swaFull", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">Full-size SWA</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.noKvOffload ?? false}
                onChange={(e) => updateConfigField("noKvOffload", e.target.checked)}
                disabled={isReadonly}
                className="accent-[var(--color-accent)]"
              />
              <span className="font-medium">Disable KV Offload</span>
            </label>

            <label htmlFor="flashAttn" className="block font-medium mt-2">
              Flash Attention
            </label>
            <select
              id="flashAttn"
              value={config.flashAttn ?? "auto"}
              onChange={(e) =>
                updateConfigField("flashAttn", e.target.value as "on" | "off" | "auto")
              }
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
              <option value="on">on</option>
              <option value="off">off</option>
              <option value="auto">auto</option>
            </select>

            <label htmlFor="cacheReuse" className="block font-medium mt-2">
              Cache Reuse (0 = default)
            </label>
            <input
              id="cacheReuse"
              type="number"
              value={config.cacheReuse ?? 0}
              onChange={(e) => updateConfigField("cacheReuse", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] px-2 py-1 border border-[var(--color-border)] rounded"
            />

            <label htmlFor="contextCheckpoints" className="block font-medium mt-2">
              Context Checkpoints
            </label>
            <input
              id="contextCheckpoints"
              type="number"
              value={config.contextCheckpoints ?? 32}
              onChange={(e) =>
                updateConfigField("contextCheckpoints", parseInt(e.target.value, 10))
              }
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] px-2 py-1 border border-[var(--color-border)] rounded"
            />

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
                    e.target.value as ModelLoadConfig["kvCacheTypeK"],
                  )
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
                <option value="f16">f16</option>
                <option value="f32">f32</option>
                <option value="bf16">bf16</option>
                <option value="q8_0">q8_0</option>
                <option value="q5_1">q5_1</option>
                <option value="q5_0">q5_0</option>
                <option value="q4_1">q4_1</option>
                <option value="q4_0">q4_0</option>
                <option value="iq4_nl">iq4_nl</option>
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
                    e.target.value as ModelLoadConfig["kvCacheTypeV"],
                  )
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
                <option value="f16">f16</option>
                <option value="f32">f32</option>
                <option value="bf16">bf16</option>
                <option value="q8_0">q8_0</option>
                <option value="q5_1">q5_1</option>
                <option value="q5_0">q5_0</option>
                <option value="q4_1">q4_1</option>
                <option value="q4_0">q4_0</option>
                <option value="iq4_nl">iq4_nl</option>
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
              value={config.ropeFreqScale ?? 0}
              onChange={(e) => updateConfigField("ropeFreqScale", parseFloat(e.target.value))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded"
            />
          </div>
        </Accordion>

        <Accordion title="Speculative Decoding">
          <div className="space-y-2 text-xs">
            {(() => {
              const availability = getSpeculativeDecodingAvailability(matchingModel, models);
              const currentType = config.specType ?? "off";
              const isInvalidMtp = currentType === "draft-mtp" && !availability.mtp;
              return (
                <>
                  <label htmlFor="specType" className="block font-medium">
                    Mode
                  </label>
                  <select
                    id="specType"
                    value={currentType}
                    onChange={(e) => {
                      const val = e.target.value as ModelLoadConfig["specType"];
                      setLocalState((prev) => {
                        if (!prev?.config) return prev;
                        const next = { ...prev.config, specType: val };
                        const detected = availability.detectedDraftPath;
                        const detectedType = availability.detectedSpecType;
                        if (detected && val === detectedType && !next.specDraftModelPath?.trim()) {
                          next.specDraftModelPath = detected;
                        } else if (
                          val === "draft-simple" &&
                          detectedType === "draft-mtp" &&
                          next.specDraftModelPath === detected
                        ) {
                          next.specDraftModelPath = "";
                        }
                        return { ...prev, config: next };
                      });
                    }}
                    disabled={isReadonly}
                    className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] p-1 rounded">
                    <option value="off">Off</option>
                    <option value="draft-mtp" disabled={!availability.mtp}>
                      MTP
                      {availability.mtp
                        ? availability.detectedSpecType === "draft-mtp"
                          ? " (assistant companion found)"
                          : ""
                        : " (no MTP model found)"}
                    </option>
                    <option value="draft-simple">
                      Draft Model
                      {availability.draftModel ? "" : " (set path below)"}
                    </option>
                  </select>
                  {isInvalidMtp && (
                    <p className="text-[11px] text-red-400">
                      Selected mode is not available for this model. Switching to Off.
                    </p>
                  )}
                  {currentType === "draft-simple" &&
                    availability.detectedSpecType === "draft-mtp" && (
                      <p className="text-[11px] text-amber-400">
                        The auto-detected companion is a Gemma MTP assistant and must be loaded with
                        MTP, not Draft Model.
                      </p>
                    )}

                  <div className="space-y-1 pt-2">
                    <label
                      htmlFor="specDraftNMax"
                      className="text-xs font-medium flex justify-between">
                      <span>Max Draft Tokens</span>
                      <span className="text-[var(--color-text-muted)] font-mono">
                        {config.specDraftNMax ?? 8}
                      </span>
                    </label>
                    <input
                      id="specDraftNMax"
                      type="range"
                      min="1"
                      max="16"
                      step="1"
                      value={config.specDraftNMax ?? 8}
                      onChange={(e) =>
                        updateConfigField("specDraftNMax", parseInt(e.target.value, 10))
                      }
                      disabled={isReadonly || currentType === "off"}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="specDraftNMin"
                      className="text-xs font-medium flex justify-between">
                      <span>Min Draft Tokens</span>
                      <span className="text-[var(--color-text-muted)] font-mono">
                        {config.specDraftNMin ?? 0}
                      </span>
                    </label>
                    <input
                      id="specDraftNMin"
                      type="range"
                      min="0"
                      max="16"
                      step="1"
                      value={config.specDraftNMin ?? 0}
                      onChange={(e) =>
                        updateConfigField("specDraftNMin", parseInt(e.target.value, 10))
                      }
                      disabled={isReadonly || currentType === "off"}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="specDraftPMin"
                      className="text-xs font-medium flex justify-between">
                      <span>Draft Probability Min</span>
                      <span className="text-[var(--color-text-muted)] font-mono">
                        {(config.specDraftPMin ?? 0.75).toFixed(2)}
                      </span>
                    </label>
                    <input
                      id="specDraftPMin"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={config.specDraftPMin ?? 0.75}
                      onChange={(e) =>
                        updateConfigField("specDraftPMin", parseFloat(e.target.value))
                      }
                      disabled={isReadonly || currentType === "off"}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1 pt-2">
                    <label htmlFor="specDraftModelPath" className="block font-medium">
                      Draft Model Path
                    </label>
                    <input
                      id="specDraftModelPath"
                      type="text"
                      value={config.specDraftModelPath || ""}
                      onChange={(e) => updateConfigField("specDraftModelPath", e.target.value)}
                      disabled={isReadonly}
                      placeholder={
                        availability.detectedDraftPath || "Absolute path to a draft/assistant GGUF"
                      }
                      className="w-full font-mono bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md disabled:opacity-50 text-xs"
                    />
                    {availability.detectedDraftPath && !config.specDraftModelPath?.trim() && (
                      <p className="text-[11px] text-[var(--color-text-muted)]">
                        Auto-detected{" "}
                        {availability.detectedSpecType === "draft-mtp"
                          ? "MTP assistant"
                          : "companion"}
                        : {fileNameFromPath(availability.detectedDraftPath)}
                      </p>
                    )}
                  </div>
                </>
              );
            })()}
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
            <label htmlFor="logLevel" className="block font-medium mt-2">
              Log Level
            </label>
            <input
              id="logLevel"
              type="number"
              value={config.logLevel ?? 3}
              onChange={(e) => updateConfigField("logLevel", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] px-2 py-1 border border-[var(--color-border)] rounded"
            />
            <label htmlFor="seedOverride" className="block font-medium mt-2">
              Seed Override (-1 = random)
            </label>
            <input
              id="seedOverride"
              type="number"
              value={config.seedOverride ?? -1}
              onChange={(e) => updateConfigField("seedOverride", parseInt(e.target.value, 10))}
              disabled={isReadonly}
              className="w-full bg-[var(--color-bg)] px-2 py-1 border border-[var(--color-border)] rounded"
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

        <section className="space-y-2 pt-2">
          <h3
            className={`text-xs font-bold uppercase tracking-wider flex items-center justify-between ${
              templateCapabilities?.hasPreserveThinking
                ? "text-[var(--color-text-muted)]"
                : "text-[var(--color-text-muted)] opacity-50"
            }`}>
            <label
              htmlFor="preserveThinking"
              title="Passes preserve_thinking = true/false to the Jinja chat template">
              Preserve Thinking
            </label>
            <input
              id="preserveThinking"
              type="checkbox"
              disabled={!!isReadonly || !templateCapabilities?.hasPreserveThinking}
              checked={
                localState.preserveThinking ??
                templateCapabilities?.preserveThinkingDefault ??
                false
              }
              onChange={(e) => updatePresetField("preserveThinking", e.target.checked)}
              className="accent-[var(--color-accent)] disabled:opacity-30"
            />
          </h3>
          <p className="text-xs text-[var(--color-text-muted)]">
            {templateCapabilities?.hasPreserveThinking
              ? "Applies on the next generation that uses this load preset. Reloading the model is not required."
              : "This load preset's chat template does not support preserve_thinking. Paste a current Jinja template into the override above to enable this control."}
          </p>
        </section>

        <Accordion title="Thinking Tag Override">
          <div className="space-y-2 text-xs">
            <p className="text-[var(--color-text-muted)]">
              Open and close tags split thinking out of the model stream. Enable Token is sent to
              the chat template as <code>enable_token</code> when set; thinking on/off is still the
              inference preset.
            </p>
            <div>
              <label htmlFor="thinkingOpenTag" className="block font-medium mb-1">
                Open Tag
              </label>
              <input
                id="thinkingOpenTag"
                type="text"
                value={localState.thinkingTagOverride?.openTag ?? ""}
                onChange={(e) =>
                  updatePresetField("thinkingTagOverride", {
                    openTag: e.target.value,
                    closeTag:
                      localState.thinkingTagOverride?.closeTag ??
                      detectThinkingTagOverride(matchingModel?.metadata?.architecture).closeTag,
                    enableToken: localState.thinkingTagOverride?.enableToken,
                  })
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
                placeholder={
                  detectThinkingTagOverride(matchingModel?.metadata?.architecture).openTag
                }
              />
            </div>
            <div>
              <label htmlFor="thinkingCloseTag" className="block font-medium mb-1">
                Close Tag
              </label>
              <input
                id="thinkingCloseTag"
                type="text"
                value={localState.thinkingTagOverride?.closeTag ?? ""}
                onChange={(e) =>
                  updatePresetField("thinkingTagOverride", {
                    openTag:
                      localState.thinkingTagOverride?.openTag ??
                      detectThinkingTagOverride(matchingModel?.metadata?.architecture).openTag,
                    closeTag: e.target.value,
                    enableToken: localState.thinkingTagOverride?.enableToken,
                  })
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
                placeholder={
                  detectThinkingTagOverride(matchingModel?.metadata?.architecture).closeTag
                }
              />
            </div>
            <div>
              <label htmlFor="thinkingEnableToken" className="block font-medium mb-1">
                Enable Token
              </label>
              <input
                id="thinkingEnableToken"
                type="text"
                value={localState.thinkingTagOverride?.enableToken ?? ""}
                onChange={(e) =>
                  updatePresetField("thinkingTagOverride", {
                    openTag:
                      localState.thinkingTagOverride?.openTag ??
                      detectThinkingTagOverride(matchingModel?.metadata?.architecture).openTag,
                    closeTag:
                      localState.thinkingTagOverride?.closeTag ??
                      detectThinkingTagOverride(matchingModel?.metadata?.architecture).closeTag,
                    enableToken: e.target.value || undefined,
                  })
                }
                disabled={isReadonly}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 outline-none font-mono text-sm"
                placeholder={
                  detectThinkingTagOverride(matchingModel?.metadata?.architecture).enableToken ??
                  "Optional"
                }
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--color-text-muted)]">
                Architecture: {matchingModel?.metadata?.architecture || "unknown"}
              </span>
              <button
                type="button"
                disabled={isReadonly}
                onClick={() =>
                  updatePresetField(
                    "thinkingTagOverride",
                    detectThinkingTagOverride(matchingModel?.metadata?.architecture),
                  )
                }
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] disabled:opacity-50">
                Detect from architecture
              </button>
            </div>
          </div>
        </Accordion>
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
