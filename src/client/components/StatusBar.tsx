/**
 * @packageDocumentation
 * Persistent bottom status bar showing conversation context occupancy and
 * LlamaForge-owned RAM / VRAM usage.
 */

import { Database, MemoryStick, MonitorPlay } from "lucide-react";
import type { AppProcessUsage, ChatContextUsage, ModelLoadConfig } from "../../shared/types";
import { useAppStore } from "../store";

/**
 * Formats a byte count as a short gibibyte string.
 *
 * @param bytes - Byte count to format.
 * @returns Human-readable GiB label.
 */
function formatGib(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0 GB";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Resolves the context occupancy that should be shown in the status bar.
 *
 * Live generation stats take precedence so the meter tracks tokens as they
 * stream; otherwise the last measured occupancy for the active chat is used.
 *
 * @param contextUsage - Backend occupancy for the selected conversation.
 * @param generationStats - Live or last-completed generation counters.
 * @param loadedConfig - Load configuration of the running model.
 * @param isGenerating - Whether a completion is currently streaming.
 * @returns Display used/total pair.
 */
export function resolveContextDisplay(
  contextUsage: ChatContextUsage | null,
  generationStats: {
    promptTokens?: number;
    totalPredicted?: number;
    contextSize?: number;
  } | null,
  loadedConfig: ModelLoadConfig | null,
  isGenerating: boolean,
): { used: number; total: number | null } {
  const total =
    (isGenerating ? generationStats?.contextSize : undefined) ||
    loadedConfig?.contextSize ||
    contextUsage?.contextSize ||
    generationStats?.contextSize ||
    null;
  if (
    isGenerating &&
    generationStats &&
    (generationStats.promptTokens !== undefined || generationStats.totalPredicted !== undefined)
  ) {
    return {
      used: (generationStats.promptTokens ?? 0) + (generationStats.totalPredicted ?? 0),
      total,
    };
  }
  return {
    used: contextUsage?.usedTokens ?? 0,
    total,
  };
}

/**
 * Bottom status bar for context occupancy and app-scoped memory usage.
 *
 * @returns Status bar element.
 */
export function StatusBar() {
  const contextUsage = useAppStore((s) => s.contextUsage);
  const processUsage = useAppStore((s) => s.processUsage);
  const generationStats = useAppStore((s) => s.generationStats);
  const loadedConfig = useAppStore((s) => s.loadedConfig);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const currentChatId = useAppStore((s) => s.currentChatId);
  const serverStatus = useAppStore((s) => s.serverStatus);

  const { used, total } = resolveContextDisplay(
    contextUsage,
    generationStats,
    loadedConfig,
    isGenerating,
  );
  const usedLabel = currentChatId ? used.toLocaleString() : "—";
  const totalLabel = total !== null ? total.toLocaleString() : "—";
  const overBudget = total !== null && currentChatId !== null && used > total;
  const memory: AppProcessUsage | null = processUsage;

  return (
    <footer
      data-testid="status-bar"
      className="h-8 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 flex items-center gap-5 text-[11px] font-mono text-[var(--color-text-secondary)] overflow-hidden">
      <span
        className={`flex items-center gap-1.5 min-w-0 ${overBudget ? "text-[var(--color-error)]" : ""}`}
        title="Tokens used by the active conversation versus the loaded context window">
        <Database size={12} className="shrink-0 text-[var(--color-accent)]" />
        <span className="truncate">
          Context: {usedLabel} / {totalLabel}
        </span>
      </span>
      <span
        className="flex items-center gap-1.5"
        title="Resident memory of the LlamaForge backend and llama-server">
        <MemoryStick size={12} className="shrink-0 text-[var(--color-accent)]" />
        <span>System RAM: {formatGib(memory?.ramBytes ?? 0)}</span>
      </span>
      <span
        className="flex items-center gap-1.5"
        title="GPU memory attributed to llama-server, excluding other applications">
        <MonitorPlay size={12} className="shrink-0 text-[var(--color-accent)]" />
        <span>
          VRAM:{" "}
          {serverStatus === "running" || (memory?.vramBytes ?? 0) > 0
            ? formatGib(memory?.vramBytes ?? 0)
            : "—"}
        </span>
      </span>
    </footer>
  );
}
