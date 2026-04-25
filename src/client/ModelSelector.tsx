/**
 * @packageDocumentation
 * Provides an inline model selector for choosing and loading models.
 */

import type { ModelEntry, ModelLoadConfig } from "@shared/types.js";
import { clsx } from "clsx";
import { ChevronDown, Cpu, Database, Loader2, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MultimodalGuardModal } from "./components/sidebar/MultimodalGuardModal";
import { useCreateChat, useLoadPresets } from "./queries";
import { useAppStore } from "./store";

/**
 * Evaluates a single model against available presets, defaulting to the optimal
 * or first available preset if none are strictly designated.
 *
 * @returns The rendered React element.
 */
export function ModelSelector() {
  const { models, loadModel, unloadModel, serverStatus, loadedModel, messages, isGenerating } =
    useAppStore();
  const { data: loadPresets } = useLoadPresets();
  const createChatMut = useCreateChat();
  const navigate = useNavigate();

  const [selectedPresets, setSelectedPresets] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("lf_selectedLoadPresets") || "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem("lf_selectedLoadPresets", JSON.stringify(selectedPresets));
  }, [selectedPresets]);

  const [guardModal, setGuardModal] = useState<{
    reason: "vision" | "audio" | "both";
    messages: any[];
    configToLoad: ModelLoadConfig;
  } | null>(null);

  const handleLoadGuard = (model: ModelEntry) => {
    if (serverStatus !== "idle" || isGenerating) return;

    // Try finding exact match by user selection, then exact match by modelPath, then default.
    const selectedPresetId = selectedPresets[model.primaryPath];
    let preset = loadPresets?.find((p) => p.id === selectedPresetId);

    if (!preset) {
      preset = loadPresets?.find((p) => p.modelPath === model.primaryPath);
    }
    if (!preset) {
      preset = loadPresets?.find((p) => p.isDefault);
    }

    const config: ModelLoadConfig = preset?.config
      ? { ...preset.config }
      : {
          modelPath: model.primaryPath,
          contextSize: 4096,
          contextShift: false,
          gpuLayers: 33,
          threads: 4,
          batchSize: 512,
          microBatchSize: 128,
          ropeScaling: "none",
          ropeFreqBase: 10000,
          ropeFreqScale: 1.0,
          kvCacheTypeK: "f16",
          kvCacheTypeV: "f16",
          mlock: false,
          noMmap: false,
          flashAttention: false,
        };

    // Always override the path to the selected model
    config.modelPath = model.primaryPath;

    // Check for multimodal incompatibility
    const hasVision =
      !!config.mmProjPath || !!model.mmProjPath || !!model.metadata?.hasVisionEncoder;
    const hasAudio = !!model.metadata?.hasAudioEncoder;

    const visionMsgs = messages.filter((m) =>
      m.attachments?.some((a) => a.mimeType.startsWith("image/")),
    );
    const audioMsgs = messages.filter((m) =>
      m.attachments?.some((a) => a.mimeType.startsWith("audio/")),
    );

    if (!hasVision && visionMsgs.length > 0 && !hasAudio && audioMsgs.length > 0) {
      setGuardModal({
        reason: "both",
        messages: [...visionMsgs, ...audioMsgs],
        configToLoad: config,
      });
      return;
    } else if (!hasVision && visionMsgs.length > 0) {
      setGuardModal({ reason: "vision", messages: visionMsgs, configToLoad: config });
      return;
    } else if (!hasAudio && audioMsgs.length > 0) {
      setGuardModal({ reason: "audio", messages: audioMsgs, configToLoad: config });
      return;
    }

    loadModel(config);
  };

  const handleStartNewChat = async () => {
    try {
      const chat = await createChatMut.mutateAsync({ name: "New Chat (Model Switch)" });
      navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
      if (guardModal) {
        loadModel(guardModal.configToLoad);
      }
    } catch (error) {
      console.error("New chat creation failed:", error);
    } finally {
      setGuardModal(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[var(--color-bg)] relative">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Loading Overlay */}
        {serverStatus === "loading" && (
          <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in">
            <Loader2 size={64} className="text-[var(--color-accent)] animate-spin mb-4" />
            <div className="text-xl font-bold text-white tracking-widest uppercase">
              Initializing Weights
            </div>
            <div className="text-sm text-gray-300 font-mono mt-2">
              Allocating VRAM and verifying structures...
            </div>
          </div>
        )}

        <div className="flex justify-between items-end pb-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-2xl font-light tracking-tight text-[var(--color-text-primary)]">
              Model Registry
            </h2>
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">
              Select and allocate weights to inference engine.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {serverStatus === "running" && (
              <button
                type="button"
                onClick={unloadModel}
                className="flex items-center space-x-2 px-4 py-2 bg-red-900/40 text-red-400 rounded-lg hover:bg-red-900/60 transition-colors text-sm font-medium border border-red-900/50">
                <Square size={14} fill="currentColor" />
                <span>Unload Active System</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {models.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl border-dashed">
              <Database size={48} className="opacity-30 mb-4" />
              <p className="text-sm font-mono">No localized GGUF structures detected in ~/Models</p>
            </div>
          ) : (
            models.map((model) => {
              const isLoaded = loadedModel?.primaryPath === model.primaryPath;

              return (
                <div
                  key={model.primaryPath}
                  className={clsx(
                    "flex flex-col sm:flex-row items-start sm:items-center justify-between p-5 rounded-2xl border transition-all",
                    isLoaded
                      ? "bg-[var(--color-surface-elevated)] border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/50"
                      : "bg-[var(--color-surface)] border-[var(--color-border)] hover:border-gray-500",
                  )}>
                  <div className="flex items-start gap-4 flex-1 min-w-0">
                    <div
                      className={clsx(
                        "p-3 rounded-xl",
                        isLoaded
                          ? "bg-[var(--color-accent)] text-white"
                          : "bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)]",
                      )}>
                      <Cpu size={24} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3">
                        <h3 className="font-bold text-lg text-[var(--color-text-primary)] truncate">
                          {model.modelName}
                        </h3>
                        {isLoaded && (
                          <span className="px-2 py-0.5 rounded-full bg-[var(--color-accent)] text-white text-[10px] font-bold uppercase tracking-widest">
                            Active
                          </span>
                        )}
                      </div>

                      <div className="mt-1.5 space-y-1 text-xs text-[var(--color-text-secondary)] font-mono">
                        <div className="truncate">{model.publisher || "Unknown Publisher"}</div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{model.metadata?.architecture || "Unknown Architecture"}</span>
                          <span className="w-1 h-1 rounded-full bg-[var(--color-border)]"></span>
                          <span>
                            {model.metadata?.fileSizeBytes
                              ? `${(model.metadata.fileSizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
                              : "Unknown Size"}
                          </span>
                          {(model.metadata?.hasVisionEncoder || model.mmProjPath) && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-[var(--color-border)]"></span>
                              <span className="text-blue-400">VISION ENABLED</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div
                        className="mt-2 text-[10px] text-[var(--color-text-muted)] truncate max-w-lg"
                        title={model.primaryPath}>
                        {model.primaryPath}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 sm:mt-0 flex items-center gap-3 shrink-0">
                    <div className="relative">
                      <select
                        disabled={serverStatus !== "idle" || isLoaded}
                        value={
                          selectedPresets[model.primaryPath] ||
                          loadPresets?.find((p) => p.modelPath === model.primaryPath)?.id ||
                          loadPresets?.find((p) => p.isDefault)?.id ||
                          ""
                        }
                        onChange={(e) =>
                          setSelectedPresets((prev) => ({
                            ...prev,
                            [model.primaryPath]: e.target.value,
                          }))
                        }
                        className="appearance-none bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-medium px-4 py-2 pr-8 rounded-xl disabled:opacity-50 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] outline-none cursor-pointer">
                        {loadPresets?.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} {p.isDefault && "(Default)"}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={14}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => handleLoadGuard(model)}
                      disabled={serverStatus !== "idle" || isLoaded}
                      className={clsx(
                        "inline-flex items-center justify-center px-6 py-2 rounded-xl font-bold text-sm transition-all",
                        isLoaded
                          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)] cursor-default"
                          : "bg-[var(--color-accent)] text-white hover:shadow-lg hover:shadow-[var(--color-accent)]/20 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed",
                      )}
                      title="Load weights">
                      {isLoaded ? (
                        "LOADED"
                      ) : (
                        <div className="flex items-center gap-2">
                          <Play size={14} fill="currentColor" />
                          <span>LOAD</span>
                        </div>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {guardModal && (
        <MultimodalGuardModal
          onClose={() => setGuardModal(null)}
          onNewChat={handleStartNewChat}
          reason={guardModal.reason}
          incompatibleMessages={guardModal.messages}
        />
      )}
    </div>
  );
}
