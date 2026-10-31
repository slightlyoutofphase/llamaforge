/**
 * @packageDocumentation
 * Full-screen overlay shown while llama-server is loading a model.
 */

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../store";

/**
 * Renders a blocking load-progress dialog whenever the inference server status is `loading`.
 *
 * @returns The overlay, or `null` when no model load is in progress.
 */
export function ModelLoadOverlay() {
  const serverStatus = useAppStore((s) => s.serverStatus);
  const loadProgress = useAppStore((s) => s.loadProgress);
  const loadProgressPhase = useAppStore((s) => s.loadProgressPhase);
  const loadProgressDetail = useAppStore((s) => s.loadProgressDetail);
  const unloadModel = useAppStore((s) => s.unloadModel);
  const [cancelling, setCancelling] = useState(false);

  if (serverStatus !== "loading") {
    return null;
  }

  const phaseLabel =
    loadProgressPhase === "spawning"
      ? "Spawning llama-server"
      : loadProgressPhase === "loading_weights"
        ? "Loading weights"
        : loadProgressPhase === "offloading"
          ? "Offloading to GPU"
          : loadProgressPhase === "initializing"
            ? "Initializing runtime"
            : loadProgressPhase === "ready"
              ? "Ready"
              : "Loading";

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in px-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="model-load-overlay-title"
      aria-busy="true">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[color:rgba(15,23,42,0.92)] p-6 shadow-2xl shadow-black/40">
        <div className="flex items-start gap-4">
          <Loader2 size={32} className="mt-1 text-[var(--color-accent)] animate-spin shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div id="model-load-overlay-title" className="text-lg font-semibold text-white">
                  Loading model
                </div>
                <div className="text-xs uppercase tracking-[0.24em] text-gray-400 mt-1">
                  {phaseLabel}
                </div>
              </div>
              <div className="text-2xl font-bold text-white tabular-nums">{loadProgress}%</div>
            </div>

            <div className="mt-4 h-3 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300 ease-out"
                style={{ width: `${Math.max(0, Math.min(100, loadProgress))}%` }}
              />
            </div>

            <div className="mt-4 flex items-center gap-3 text-sm text-gray-200">
              <Loader2 size={16} className="text-[var(--color-accent)] animate-spin shrink-0" />
              <span className="font-mono truncate">
                {loadProgressDetail || "Starting model load sequence…"}
              </span>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                data-testid="cancel-model-load"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  void unloadModel().finally(() => setCancelling(false));
                }}
                className="rounded-xl border border-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/10 disabled:opacity-50">
                {cancelling ? "Cancelling…" : "Cancel load"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
