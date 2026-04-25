/**
 * @packageDocumentation
 * Provides the model library panel for browsing and loading GGUF models.
 */

import { clsx } from "clsx";
import {
  Activity,
  Check,
  Cpu,
  HardDrive,
  Layers,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useState } from "react";
import { useCreateChat, useLoadPresets } from "../../queries";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { MultimodalGuardModal } from "./MultimodalGuardModal";

/**
 * Sidebar panel displaying available AI models, allowing users to select, load,
 * and clear them from RAM/VRAM.
 *
 * @returns The rendered React element.
 */
export function ModelLibraryPanel() {
  const { models, loadModel, loadedModel, isGenerating, messages } = useAppStore();
  const { setRightPanelView } = useUiStore();
  const { data: loadPresets } = useLoadPresets();
  const createChatMut = useCreateChat();
  const [search, setSearch] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [guardModal, setGuardModal] = useState<{
    reason: "vision" | "audio" | "both";
    messages: any[];
  } | null>(null);

  const filteredModels = models.filter(
    (m) =>
      m.modelName.toLowerCase().includes(search.toLowerCase()) ||
      m.primaryPath.toLowerCase().includes(search.toLowerCase()),
  );

  const selectedModel = models.find((m) => m.primaryPath === selectedPath);
  const defaultLoadPreset = loadPresets?.find((p) => p.isDefault) || loadPresets?.[0];

  const handleLoad = (p: { id: string; config: any; thinkingTagOverride?: any }) => {
    if (!selectedModel || isGenerating) return;

    // Check for multimodal incompatibility
    const hasVision =
      !!p.config.mmProjPath ||
      !!selectedModel.mmProjPath ||
      !!selectedModel.metadata?.hasVisionEncoder;
    const hasAudio = !!selectedModel.metadata?.hasAudioEncoder;

    const visionMsgs = messages.filter((m) =>
      m.attachments?.some((a) => a.mimeType.startsWith("image/")),
    );
    const audioMsgs = messages.filter((m) =>
      m.attachments?.some((a) => a.mimeType.startsWith("audio/")),
    );

    if (!hasVision && visionMsgs.length > 0 && !hasAudio && audioMsgs.length > 0) {
      setGuardModal({ reason: "both", messages: [...visionMsgs, ...audioMsgs] });
      return;
    } else if (!hasVision && visionMsgs.length > 0) {
      setGuardModal({ reason: "vision", messages: visionMsgs });
      return;
    } else if (!hasAudio && audioMsgs.length > 0) {
      setGuardModal({ reason: "audio", messages: audioMsgs });
      return;
    }

    loadModel({
      ...p.config,
      modelPath: selectedModel.primaryPath,
      thinkingTagOverride: p.thinkingTagOverride,
      presetId: p.id,
    });
  };

  const handleStartNewChat = () => {
    createChatMut.mutate({ name: "New Chat (Model Switch)" });
    setGuardModal(null);
    setRightPanelView(null);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-[450px] shadow-xl overflow-hidden shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
        <div>
          <h2 className="font-semibold text-lg flex items-center gap-2">Model Registry</h2>
          <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold">
            Local Model Inventory
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Rescan model directory"
            onClick={() => useAppStore.getState().fetchModels()}
            className="p-1.5 hover:bg-[var(--color-border)] rounded-lg transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <RefreshCw size={18} />
          </button>
          <button
            type="button"
            onClick={() => setRightPanelView(null)}
            className="p-1.5 hover:bg-[var(--color-border)] rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="p-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl pl-10 pr-4 py-2 text-sm focus:border-[var(--color-accent)] outline-none transition-all shadow-inner"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {filteredModels.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-muted)]">
            <HardDrive size={48} className="opacity-20 mb-4" />
            <p className="text-sm">No models found in the registry.</p>
          </div>
        ) : (
          filteredModels.map((model) => {
            const isLoaded = loadedModel?.primaryPath === model.primaryPath;
            const isSelected = selectedPath === model.primaryPath;

            return (
              <div key={model.primaryPath} className="space-y-2">
                <button
                  type="button"
                  className={clsx(
                    "w-full text-left group relative border rounded-2xl p-4 transition-all hover:shadow-md cursor-pointer",
                    isLoaded
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5 shadow-inner"
                      : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-text-muted)]",
                    isSelected && !isLoaded && "ring-2 ring-[var(--color-accent)]/30",
                  )}
                  onClick={() => setSelectedPath(isSelected ? null : model.primaryPath)}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className={clsx(
                          "p-2 rounded-lg transition-colors",
                          isLoaded
                            ? "bg-[var(--color-accent)] text-white"
                            : "bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]",
                        )}>
                        <Cpu size={20} />
                      </div>
                      <div>
                        <h3 className="font-semibold text-[var(--color-text-primary)] leading-tight">
                          {model.modelName}
                        </h3>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] font-mono">
                            <span className="bg-[var(--color-surface-elevated)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                              {model.metadata?.architecture || "Unknown Arch"}
                            </span>
                            <span>
                              {(
                                (model.metadata?.fileSizeBytes || 0) /
                                (1024 * 1024 * 1024)
                              ).toFixed(2)}{" "}
                              GB
                            </span>
                          </div>
                          {(model.mmProjPath || model.metadata?.hasVisionEncoder) && (
                            <span className="bg-blue-500/10 text-blue-500 text-[9px] font-bold px-1.5 py-0.5 rounded border border-blue-500/20 uppercase tracking-wider">
                              Vision
                            </span>
                          )}
                          {model.metadata?.hasAudioEncoder && (
                            <span className="bg-purple-500/10 text-purple-500 text-[9px] font-bold px-1.5 py-0.5 rounded border border-purple-500/20 uppercase tracking-wider">
                              Audio
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {isLoaded && (
                      <div className="bg-[var(--color-success)] text-white p-1 rounded-full animate-in fade-in zoom-in duration-300">
                        <Check size={12} />
                      </div>
                    )}
                  </div>

                  <div
                    className="text-[10px] text-[var(--color-text-muted)] font-mono truncate"
                    title={model.primaryPath}>
                    {model.primaryPath}
                  </div>
                </button>

                {isSelected && (
                  <div className="bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-2xl p-4 shadow-sm animate-in slide-in-from-top-2 duration-200 space-y-4">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                      <div className="flex items-center gap-2 text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
                        <Activity size={12} /> Context Limit
                      </div>
                      <div className="text-xs font-mono text-right">
                        {model.metadata?.contextLength?.toLocaleString() || "Unknown"} tokens
                      </div>

                      <div className="flex items-center gap-2 text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
                        <Layers size={12} /> Attention Heads
                      </div>
                      <div className="text-xs font-mono text-right">
                        {model.metadata?.attentionHeadCount || "Unknown"}
                      </div>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
                          Load with Preset
                        </div>
                        <button
                          type="button"
                          onClick={() => setRightPanelView("loadPreset", defaultLoadPreset?.id)}
                          className="text-[10px] text-[var(--color-accent)] hover:underline font-bold">
                          MANAGE PRESETS
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {loadPresets
                          ?.filter((p) => !p.modelPath || p.modelPath === model.primaryPath)
                          .map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              disabled={isGenerating}
                              onClick={() => handleLoad(p)}
                              className="bg-[var(--color-bg)] border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50">
                              <Settings size={12} />
                              {p.name}
                            </button>
                          ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[10px] text-[var(--color-text-muted)] italic">
        Scanned from: ~/.llamaforge/models
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
