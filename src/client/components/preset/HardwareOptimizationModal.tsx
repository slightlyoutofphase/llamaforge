/**
 * @packageDocumentation
 * A hardware-aware optimization dialogue that calculates and applies optimal inference settings.
 */

import type { ModelLoadConfig } from "@shared/types.js";
import { AlertCircle, Check, Cpu, Loader2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useOptimizeHardware } from "../../queries";
import { useAppStore } from "../../store";

/**
 * Props for the HardwareOptimizationModal component.
 */
interface HardwareOptimizationModalProps {
  /** Callback to close the modal without applying changes. */
  onClose: () => void;
  /** Callback invoked when settings are applied, receiving the optimized partial configuration. */
  onApply: (config: Partial<ModelLoadConfig>) => void;
  /** Path to the model file for which optimization is being calculated. */
  modelPath: string;
}

/**
 * Renders a modal overlay that performs automatic hardware calibration for a specific model.
 * Uses the backend optimizer service to estimate thread counts, GPU layers, and memory usage.
 *
 * @param props - Component properties.
 * @returns React functional component.
 */
export function HardwareOptimizationModal({
  onClose,
  onApply,
  modelPath,
}: HardwareOptimizationModalProps) {
  const { hardware: hardwareInfo } = useAppStore();
  const optimizeMut = useOptimizeHardware();
  const [optimizedConfig, setOptimizedConfig] = useState<Partial<ModelLoadConfig> | null>(null);

  useEffect(() => {
    if (modelPath) {
      optimizeMut.mutate(modelPath, {
        onSuccess: (data) => setOptimizedConfig(data),
      });
    }
  }, [modelPath, optimizeMut.mutate]);

  const getSuggestions = (config: Partial<ModelLoadConfig>) => {
    const suggestions: string[] = [];
    if (config.gpuLayers !== undefined) {
      suggestions.push(
        config.gpuLayers > 0
          ? `Offloading ${config.gpuLayers} layers to GPU.`
          : "Running on CPU (insufficient VRAM).",
      );
    }
    if (config.contextSize) {
      suggestions.push(`Optimized context size to ${config.contextSize} based on memory.`);
    }
    if (config.threads) {
      suggestions.push(`Set ${config.threads} parallel threads for optimal CPU utilization.`);
    }
    if (config.mlock) {
      suggestions.push("Enabling mlock to prevent memory swapping.");
    }
    if (config.kvCacheTypeK === "q8_0") {
      suggestions.push("Using 8-bit quantized KV cache to save memory.");
    }
    return suggestions;
  };

  const suggestions = optimizedConfig ? getSuggestions(optimizedConfig) : [];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        <div className="p-6 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface-elevated)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--color-accent)]/10 text-[var(--color-accent)] rounded-lg">
              <Zap size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold">Optimization Engine</h2>
              <p className="text-sm text-[var(--color-text-muted)]">Hardware-aware calibration</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto max-h-[60vh]">
          {optimizeMut.isPending ? (
            <div className="flex flex-col items-center py-12 text-center space-y-4">
              <Loader2 size={48} className="text-[var(--color-accent)] animate-spin opacity-50" />
              <p className="text-[var(--color-text-secondary)]">Analyzing hardware and model...</p>
            </div>
          ) : !optimizedConfig ? (
            <div className="flex flex-col items-center py-8 text-center">
              <AlertCircle size={48} className="text-yellow-500 mb-4 opacity-50" />
              <p>Hardware information profile not yet loaded. Please wait for health probe.</p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
                  Detected Hardware
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl col-span-2">
                    <div className="flex items-center gap-2 mb-1 text-[var(--color-text-muted)]">
                      <Cpu size={14} />{" "}
                      <span className="text-[10px] font-bold uppercase">CPU & Logic</span>
                    </div>
                    <div className="text-sm font-semibold">
                      {hardwareInfo?.cpuThreads} Logical Threads Available
                    </div>
                  </div>
                  <div className="p-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl">
                    <div className="flex items-center gap-2 mb-1 text-[var(--color-text-muted)]">
                      <Zap size={14} /> <span className="text-[10px] font-bold uppercase">RAM</span>
                    </div>
                    <div className="text-sm font-semibold">
                      {Math.round((hardwareInfo?.totalRamBytes || 0) / (1024 * 1024 * 1024))} GB
                      Total
                    </div>
                  </div>
                  <div className="p-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl">
                    <div className="flex items-center gap-2 mb-1 text-[var(--color-text-muted)]">
                      <Zap size={14} />{" "}
                      <span className="text-[10px] font-bold uppercase">GPU Count</span>
                    </div>
                    <div className="text-sm font-semibold">
                      {hardwareInfo?.gpus.length || 0} Devices Found
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
                  Applied Optimizations
                </h3>
                <div className="space-y-2">
                  {suggestions.map((s, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
                      <Check size={16} className="text-[var(--color-success)] shrink-0 mt-0.5" />
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs text-blue-200 leading-relaxed italic">
                Note: These values are heuristics based on your current OS-reported resources. For
                large models (e.g. 70B), manual adjustment of GPU layers may still be required.
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-[var(--color-border)] rounded-xl hover:bg-[var(--color-surface)] transition-colors font-semibold">
            Cancel
          </button>
          <button
            type="button"
            disabled={!optimizedConfig}
            onClick={() => optimizedConfig && onApply(optimizedConfig)}
            className="flex-1 px-4 py-2 bg-[var(--color-accent)] text-white rounded-xl hover:shadow-lg transition-all font-semibold flex items-center justify-center gap-2">
            <Zap size={16} /> Apply Settings
          </button>
        </div>
      </div>
    </div>
  );
}
