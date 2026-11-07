/**
 * @packageDocumentation
 * Full-screen overlay shown while llama-server is loading a model.
 */

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../store";

/**
 * Renders a blocking spinner while the inference server status is `loading`.
 *
 * The overlay does not estimate a percentage. Cancel still stops the load.
 *
 * @returns The overlay, or `null` when no model load is in progress.
 */
export function ModelLoadOverlay() {
  const serverStatus = useAppStore((s) => s.serverStatus);
  const unloadModel = useAppStore((s) => s.unloadModel);
  const [cancelling, setCancelling] = useState(false);

  if (serverStatus !== "loading") {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in px-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="model-load-overlay-title"
      aria-busy="true">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[color:rgba(15,23,42,0.92)] px-8 py-10 shadow-2xl shadow-black/40">
        <div className="flex flex-col items-center text-center">
          <Loader2 size={48} className="text-[var(--color-accent)] animate-spin" />
          <div id="model-load-overlay-title" className="mt-5 text-lg font-semibold text-white">
            Loading model
          </div>
          <button
            type="button"
            data-testid="cancel-model-load"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void unloadModel().finally(() => setCancelling(false));
            }}
            className="mt-6 rounded-xl border border-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/10 disabled:opacity-50">
            {cancelling ? "Cancelling…" : "Cancel load"}
          </button>
        </div>
      </div>
    </div>
  );
}
