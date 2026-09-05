/**
 * @packageDocumentation
 * Provides an inline model selector for choosing and loading models.
 */

import { useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ChevronDown, Cpu, Database, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createDefaultLoadConfig } from "../shared/defaults";
import type { ChatMessage, LoadModelRequest, ModelEntry, ModelLoadConfig } from "../shared/types";
import { MultimodalGuardModal } from "./components/sidebar/MultimodalGuardModal";
import { logError } from "./logger";
import { useCreateChat, useLoadPresets, useSettings } from "./queries";
import { useAppStore } from "./store";

/**
 * Evaluates a single model against available presets, defaulting to the optimal
 * or first available preset if none are strictly designated.
 *
 * @returns The rendered React element.
 */
export function ModelSelector() {
  const models = useAppStore((s) => s.models);
  const loadModel = useAppStore((s) => s.loadModel);
  const unloadModel = useAppStore((s) => s.unloadModel);
  const serverStatus = useAppStore((s) => s.serverStatus);
  const loadedModel = useAppStore((s) => s.loadedModel);
  const messages = useAppStore((s) => s.messages);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const { data: loadPresets } = useLoadPresets();
  const { data: settings } = useSettings();
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
    messages: ChatMessage[];
    configToLoad: LoadModelRequest;
  } | null>(null);
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const createChatLockRef = useRef(false);

  /**
   * Validates multimodal compatibility and submits a model-load request when the model can be used safely.
   *
   * @param model - Candidate model selected from the registry.
   * @returns A promise that resolves once the guard or load workflow completes.
   */
  const handleLoadGuard = async (model: ModelEntry) => {
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
      : createDefaultLoadConfig(model.primaryPath);

    // Always override the path to the selected model
    config.modelPath = model.primaryPath;

    const request: LoadModelRequest = {
      ...config,
      ...(preset?.id ? { presetId: preset.id } : {}),
      ...(preset?.thinkingTagOverride ? { thinkingTagOverride: preset.thinkingTagOverride } : {}),
    };

    if (
      (config.specType === "draft-simple" || config.specType === "draft-eagle3") &&
      model.draftModelPath
    ) {
      request.specDraftModelPath = model.draftModelPath;
    }

    const defaultTemplate = model.metadata?.chatTemplate;
    if (
      preset?.chatTemplateOverride &&
      preset.chatTemplateOverride.length > 0 &&
      preset.chatTemplateOverride !== defaultTemplate
    ) {
      request.chatTemplateContent = preset.chatTemplateOverride;
    }

    // Check for multimodal incompatibility
    const hasVision = !!model.metadata?.hasVisionEncoder;
    const hasAudio = !!model.metadata?.hasAudioEncoder;

    const visionMsgs = messages.filter((m) =>
      m.attachments?.some(
        (a) => a.mimeType.startsWith("image/") || a.mimeType.startsWith("video/"),
      ),
    );
    const audioMsgs = messages.filter((m) =>
      m.attachments?.some((a) => a.mimeType.startsWith("audio/")),
    );

    if (!hasVision && visionMsgs.length > 0 && !hasAudio && audioMsgs.length > 0) {
      setGuardModal({
        reason: "both",
        messages: [...visionMsgs, ...audioMsgs],
        configToLoad: request,
      });
      return;
    } else if (!hasVision && visionMsgs.length > 0) {
      setGuardModal({ reason: "vision", messages: visionMsgs, configToLoad: request });
      return;
    } else if (!hasAudio && audioMsgs.length > 0) {
      setGuardModal({ reason: "audio", messages: audioMsgs, configToLoad: request });
      return;
    }

    const success = await loadModel(request);
    if (success) {
      // Just keep them on the registry, the card will show 'ACTIVE'
    }
  };

  /**
   * Creates a replacement chat before switching to a model that cannot handle current attachments.
   *
   * @returns A promise that resolves once the replacement chat and guarded load flow complete.
   */
  const handleStartNewChat = async () => {
    if (isCreatingChat || createChatLockRef.current) return;
    createChatLockRef.current = true;
    setIsCreatingChat(true);
    try {
      const chat = await createChatMut.mutateAsync({ name: "New Chat (Model Switch)" });
      if (chat?.id) {
        navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
      }
      if (guardModal) {
        loadModel(guardModal.configToLoad);
      }
    } catch (error) {
      logError("New chat creation failed:", error);
    } finally {
      createChatLockRef.current = false;
      setIsCreatingChat(false);
      setGuardModal(null);
    }
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6 bg-[var(--color-bg)] relative">
      <div className="w-full max-w-full mx-auto space-y-6">
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {models.filter((m) => !m.metadata?.isDraftModel).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl border-dashed">
              <Database size={48} className="opacity-30 mb-4" />
              <p className="text-sm font-mono">
                No localized GGUF structures detected in{" "}
                {settings?.modelsPath || "the configured models directory"}
              </p>
            </div>
          ) : (
            models
              .filter((m) => !m.metadata?.isDraftModel)
              .map((model) => {
                const isLoaded = loadedModel?.primaryPath === model.primaryPath;

                return (
                  <div
                    key={model.primaryPath}
                    className={clsx(
                      "flex flex-col gap-4 p-5 rounded-2xl border transition-all overflow-hidden w-full min-w-0",
                      isLoaded
                        ? "bg-[var(--color-surface-elevated)] border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/50"
                        : "bg-[var(--color-surface)] border-[var(--color-border)] hover:border-gray-500",
                    )}>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 min-w-0 w-full">
                      <div
                        className={clsx(
                          "p-3 rounded-xl flex-shrink-0",
                          isLoaded
                            ? "bg-[var(--color-accent)] text-white"
                            : "bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)]",
                        )}>
                        <Cpu size={24} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 min-w-0 w-full">
                          <h3 className="font-bold text-lg text-[var(--color-text-primary)] truncate min-w-0 max-w-full">
                            {model.modelName}
                          </h3>
                          {isLoaded && (
                            <span className="px-2 py-0.5 rounded-full bg-[var(--color-accent)] text-white text-[10px] font-bold uppercase tracking-widest">
                              Active
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)] font-mono min-w-0">
                          <span className="truncate max-w-full">
                            {model.publisher || "Unknown Publisher"}
                          </span>
                          <span className="text-[var(--color-border)]">•</span>
                          <span className="truncate max-w-full">
                            {model.metadata?.architecture || "Unknown Architecture"}
                          </span>
                          <span className="text-[var(--color-border)]">•</span>
                          <span className="truncate max-w-full">
                            {model.metadata?.fileSizeBytes
                              ? `${(model.metadata.fileSizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
                              : "Unknown Size"}
                          </span>
                          {model.metadata?.hasVisionEncoder && (
                            <span className="text-blue-400 truncate max-w-full">
                              VISION ENABLED
                            </span>
                          )}
                          {model.metadata?.hasAudioEncoder && (
                            <span className="text-purple-400 truncate max-w-full">
                              AUDIO ENABLED
                            </span>
                          )}
                          {model.modelName.toLowerCase().includes("mtp") && (
                            <span className="text-green-400 truncate max-w-full">MTP ENABLED</span>
                          )}
                        </div>

                        <div
                          className="mt-2 text-[10px] text-[var(--color-text-muted)] break-all whitespace-pre-wrap"
                          title={model.primaryPath}>
                          {model.primaryPath}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:justify-between gap-3 items-stretch sm:items-center w-full min-w-0">
                      <div className="relative w-full sm:max-w-[22rem] min-w-0">
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
                          className="w-full appearance-none bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-medium px-4 py-2 pr-8 rounded-xl disabled:opacity-50 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] outline-none cursor-pointer">
                          {loadPresets
                            ?.filter((p) => !p.modelPath || p.modelPath === model.primaryPath)
                            .map((p) => (
                              <option key={p.id} value={p.id} title={p.name}>
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
                          "inline-flex items-center justify-center w-full sm:w-auto px-6 py-2 rounded-xl font-bold text-sm transition-all",
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
          isNewChatDisabled={isCreatingChat}
          reason={guardModal.reason}
          incompatibleMessages={guardModal.messages}
        />
      )}
    </div>
  );
}
