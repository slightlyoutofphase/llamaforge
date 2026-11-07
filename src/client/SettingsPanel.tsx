/**
 * @packageDocumentation
 * Right sidebar panel for managing application-wide settings: theme, paths, and advanced flags.
 */

import { DEFAULT_APP_SETTINGS } from "@shared/defaults";
import type { AppSettings } from "@shared/types";
import { Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NumberDraftInput } from "./components/DraftInputs";
import { useSettings, useUpdateSettings } from "./queries";
import { useAppStore } from "./store";
import { useUiStore } from "./uiStore";

/** Settings keys that autosave must not write back. */
const OMITTED_FROM_AUTOSAVE = new Set<keyof AppSettings>([
  "lastLoadConfig",
  "lastLoadThinkingTagOverride",
  "modelsPath",
]);

/**
 * Builds the settings fields that changed, excluding values the server owns.
 *
 * `lastLoadConfig` is written by model load. Sending the panel's copy back
 * overwrites a model that was loaded while settings were open. `modelsPath`
 * is saved on blur or by Rescan so a half-typed directory is not scanned.
 *
 * @param previous - Last settings snapshot stored in the panel.
 * @param next - Current editor state.
 * @returns Only the keys that should be written by autosave.
 */
function changedAutosaveSettings(
  previous: Partial<AppSettings>,
  next: Partial<AppSettings>,
): Partial<AppSettings> {
  const updates: Partial<AppSettings> = {};
  const keys = new Set<keyof AppSettings>([
    ...(Object.keys(previous) as (keyof AppSettings)[]),
    ...(Object.keys(next) as (keyof AppSettings)[]),
  ]);
  for (const key of keys) {
    if (OMITTED_FROM_AUTOSAVE.has(key)) continue;
    if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
    updates[key] = next[key] as never;
  }
  return updates;
}

/**
 * Component for editing application settings.
 * Includes sections for binary paths, presets navigation, appearance, and advanced network settings.
 *
 * @returns React functional component.
 */
export function SettingsPanel() {
  const { setRightPanelView } = useUiStore();
  const { data: settings, isLoading } = useSettings();
  const updateMut = useUpdateSettings();

  const [localState, setLocalState] = useState<Partial<AppSettings>>({});
  const lastPersistedStateRef = useRef<Partial<AppSettings> | null>(null);
  const hasHydratedRef = useRef(false);
  const saveTimeoutRef = useRef<number | null>(null);
  const persistSettingsRef = useRef(updateMut.mutate);
  persistSettingsRef.current = updateMut.mutate;

  useEffect(() => {
    if (!settings || hasHydratedRef.current) return;
    setLocalState(settings);
    lastPersistedStateRef.current = settings;
    hasHydratedRef.current = true;
  }, [settings]);

  /**
   * Writes a committed numeric setting into the panel state that autosave watches.
   *
   * @param key - Settings field that was committed from a number draft.
   * @param value - Parsed number, or `undefined` when the draft was empty.
   * @returns No return value.
   */
  const commitNumericSetting = (
    key: "llamaPortRangeMin" | "llamaPortRangeMax" | "requestTimeoutSeconds" | "serverPort",
    value: number | undefined,
  ) => {
    if (value === undefined) return;
    setLocalState((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (!hasHydratedRef.current || !lastPersistedStateRef.current) {
      return;
    }

    const pendingState = localState;
    const previousState = lastPersistedStateRef.current;
    const updates = changedAutosaveSettings(previousState, pendingState);
    if (Object.keys(updates).length === 0) return;

    const timeoutId = window.setTimeout(() => {
      persistSettingsRef.current(updates, {
        onSuccess: () => {
          lastPersistedStateRef.current = {
            ...previousState,
            ...updates,
          };
        },
      });
    }, 250);
    saveTimeoutRef.current = timeoutId;

    return () => window.clearTimeout(timeoutId);
  }, [localState]);

  /**
   * Writes the models directory when it changed, then runs the follow-up scan.
   *
   * @param afterSave - Called after the path is stored, or immediately when it is unchanged.
   * @returns No return value.
   */
  const saveModelsPath = (afterSave: () => void) => {
    const modelsPath = localState.modelsPath ?? "";
    const previous = lastPersistedStateRef.current;
    if (!previous || previous.modelsPath === modelsPath) {
      afterSave();
      return;
    }
    persistSettingsRef.current(
      { modelsPath },
      {
        onSuccess: () => {
          lastPersistedStateRef.current = { ...previous, modelsPath };
          afterSave();
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-80 shadow-xl overflow-hidden shrink-0 items-center justify-center">
        <Loader2 className="animate-spin text-[var(--color-accent)]" size={32} />
      </div>
    );
  }

  return (
    <div
      data-testid="settings-panel"
      className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-80 shadow-xl overflow-hidden shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)]">
        <h2 className="font-semibold text-lg flex items-center gap-2">Settings</h2>
        <button
          type="button"
          onClick={() => setRightPanelView(null)}
          className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-8">
        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Binary Paths
          </h3>
          <div className="space-y-2">
            <label htmlFor="llamaServerPath" className="text-sm font-medium">
              llama-server Path
            </label>
            <input
              id="llamaServerPath"
              type="text"
              value={localState.llamaServerPath || ""}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, llamaServerPath: e.target.value }))
              }
              placeholder="/usr/local/bin/llama-server"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="modelsPath" className="text-sm font-medium">
              Models root directory
            </label>
            <input
              id="modelsPath"
              type="text"
              value={localState.modelsPath || ""}
              onChange={(e) => setLocalState((prev) => ({ ...prev, modelsPath: e.target.value }))}
              onBlur={() => {
                saveModelsPath(() => {
                  void useAppStore.getState().fetchModels();
                });
              }}
              placeholder={settings?.modelsPath || "Models directory"}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
            />
            <button
              type="button"
              onClick={() => {
                if (saveTimeoutRef.current !== null) {
                  window.clearTimeout(saveTimeoutRef.current);
                  saveTimeoutRef.current = null;
                }
                saveModelsPath(() => {
                  void useAppStore.getState().rescanModels();
                });
              }}
              className="w-full mt-1 flex items-center justify-center gap-2 px-3 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] active:bg-[var(--color-border)] active:scale-[0.98] transition-colors text-xs font-medium">
              <RefreshCw size={14} />
              Rescan Models
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-2">
              <label htmlFor="nvidiaSmiPath" className="text-sm font-medium">
                nvidia-smi Path (Optional)
              </label>
              <input
                id="nvidiaSmiPath"
                type="text"
                value={localState.nvidiaSmiPath || ""}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, nvidiaSmiPath: e.target.value }))
                }
                placeholder="nvidia-smi"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="rocmSmiPath" className="text-sm font-medium">
                rocm-smi Path (Optional)
              </label>
              <input
                id="rocmSmiPath"
                type="text"
                value={localState.rocmSmiPath || ""}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, rocmSmiPath: e.target.value }))
                }
                placeholder="rocm-smi"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="sysctlPath" className="text-sm font-medium">
                sysctl Path (Optional)
              </label>
              <input
                id="sysctlPath"
                type="text"
                value={localState.sysctlPath || ""}
                onChange={(e) => setLocalState((prev) => ({ ...prev, sysctlPath: e.target.value }))}
                placeholder="sysctl"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="systemProfilerPath" className="text-sm font-medium">
                system_profiler Path (Optional)
              </label>
              <input
                id="systemProfilerPath"
                type="text"
                value={localState.systemProfilerPath || ""}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, systemProfilerPath: e.target.value }))
                }
                placeholder="system_profiler"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="powershellPath" className="text-sm font-medium">
                PowerShell Path (Optional)
              </label>
              <input
                id="powershellPath"
                type="text"
                value={localState.powershellPath || ""}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, powershellPath: e.target.value }))
                }
                placeholder="powershell"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Presets Management
          </h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Inference Presets</span>
              <button
                type="button"
                onClick={() => setRightPanelView("inferencePreset")}
                className="text-xs bg-[var(--color-surface-elevated)] px-2 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-bg)] transition-colors">
                Manage
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Load Presets</span>
              <button
                type="button"
                onClick={() => setRightPanelView("loadPreset")}
                className="text-xs bg-[var(--color-surface-elevated)] px-2 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-bg)] transition-colors">
                Manage
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">System Prompt Presets</span>
              <button
                type="button"
                onClick={() => setRightPanelView("systemPreset")}
                className="text-xs bg-[var(--color-surface-elevated)] px-2 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-bg)] transition-colors">
                Manage
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Appearance
          </h3>
          <div className="space-y-2">
            <label htmlFor="themeSelect" className="text-sm font-medium">
              Theme
            </label>
            <select
              id="themeSelect"
              value={localState.theme || "system"}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  theme: e.target.value as AppSettings["theme"],
                }))
              }
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none">
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="flex items-center justify-between py-1">
            <label htmlFor="autonameToggle" className="text-sm font-medium cursor-pointer">
              Autoname Chats
            </label>
            <input
              id="autonameToggle"
              type="checkbox"
              checked={!!localState.autonameEnabled}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, autonameEnabled: e.target.checked }))
              }
              className="w-4 h-4 accent-[var(--color-accent)]"
            />
          </div>
          <div className="flex items-center justify-between py-1">
            <label htmlFor="autoloadToggle" className="text-sm font-medium cursor-pointer">
              Reload Last Used Model Automatically
            </label>
            <input
              id="autoloadToggle"
              type="checkbox"
              checked={localState.autoloadLastModel ?? DEFAULT_APP_SETTINGS.autoloadLastModel}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, autoloadLastModel: e.target.checked }))
              }
              className="w-4 h-4 accent-[var(--color-accent)]"
            />
          </div>
          <div className="flex items-center justify-between py-1">
            <label htmlFor="showConsoleToggle" className="text-sm font-medium cursor-pointer">
              Show Console on Startup
            </label>
            <input
              id="showConsoleToggle"
              type="checkbox"
              checked={!!localState.showConsoleOnStartup}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, showConsoleOnStartup: e.target.checked }))
              }
              className="w-4 h-4 accent-[var(--color-accent)]"
            />
          </div>
          <div className="space-y-3">
            <span className="text-sm font-medium">Accent Color</span>
            <div className="flex flex-wrap gap-2">
              {[
                "#7b6ef6",
                "#3b82f6",
                "#8b5cf6",
                "#ec4899",
                "#ef4444",
                "#f59e0b",
                "#10b981",
                "#06b6d4",
                "#6366f1",
              ].map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setLocalState((prev) => ({ ...prev, accentColor: color }))}
                  className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${localState.accentColor === color ? "border-white scale-110 shadow-sm" : "border-transparent"}`}
                  style={{ backgroundColor: color }}
                />
              ))}
              <div className="relative w-6 h-6 rounded-full overflow-hidden border border-[var(--color-border)]">
                <input
                  type="color"
                  value={
                    localState.accentColor && /^#[0-9A-Fa-f]{6}$/.test(localState.accentColor)
                      ? localState.accentColor
                      : "#7b6ef6"
                  }
                  onChange={(e) =>
                    setLocalState((prev) => ({ ...prev, accentColor: e.target.value }))
                  }
                  className="absolute inset-0 w-[150%] h-[150%] -translate-x-[20%] -translate-y-[20%] cursor-pointer"
                />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="chatStyle" className="text-sm font-medium">
              Chat Bubble Style
            </label>
            <select
              id="chatStyle"
              value={localState.chatBubbleStyle || "bubble"}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  chatBubbleStyle: e.target.value as AppSettings["chatBubbleStyle"],
                }))
              }
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm">
              <option value="bubble">Bubble</option>
              <option value="flat">Flat</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Advanced
          </h3>
          <div className="flex items-center justify-between py-1 gap-3">
            <div className="min-w-0">
              <label
                htmlFor="includeVideoAudioToggle"
                className="text-sm font-medium cursor-pointer">
                Include Audio From Videos
              </label>
              <p className="text-[10px] text-[var(--color-text-muted)] leading-snug mt-1">
                When a video has a soundtrack, also send it as separate audio. The switch is ignored
                when general.architecture is lfm3 because that model receives the soundtrack from
                the video file. The checkbox remains stored and remains effective for every other
                architecture.
              </p>
            </div>
            <input
              id="includeVideoAudioToggle"
              type="checkbox"
              checked={localState.includeVideoAudio ?? DEFAULT_APP_SETTINGS.includeVideoAudio}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, includeVideoAudio: e.target.checked }))
              }
              className="w-4 h-4 accent-[var(--color-accent)] shrink-0"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="logLevel" className="text-sm font-medium">
              Log Level
            </label>
            <select
              id="logLevel"
              value={localState.logLevel || "info"}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  logLevel: e.target.value as AppSettings["logLevel"],
                }))
              }
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm">
              <option value="off">Off</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
              <option value="verbose">Verbose</option>
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor="fontSize" className="text-sm font-medium flex justify-between">
              <span>Font Size</span>
              <span>{localState.fontSize || 14}px</span>
            </label>
            <input
              id="fontSize"
              type="range"
              min="12"
              max="18"
              step="1"
              value={localState.fontSize || 14}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, fontSize: parseInt(e.target.value, 10) }))
              }
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <label htmlFor="portMin" className="text-sm font-medium line-clamp-1">
                Llama Port Min
              </label>
              <NumberDraftInput
                id="portMin"
                integer
                min={1}
                max={localState.llamaPortRangeMax ?? DEFAULT_APP_SETTINGS.llamaPortRangeMax}
                value={localState.llamaPortRangeMin}
                onCommit={(value) => commitNumericSetting("llamaPortRangeMin", value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="portMax" className="text-sm font-medium line-clamp-1">
                Llama Port Max
              </label>
              <NumberDraftInput
                id="portMax"
                integer
                min={localState.llamaPortRangeMin ?? DEFAULT_APP_SETTINGS.llamaPortRangeMin}
                max={65535}
                value={localState.llamaPortRangeMax}
                onCommit={(value) => commitNumericSetting("llamaPortRangeMax", value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="timeout" className="text-sm font-medium">
              Generation inactivity timeout (sec)
            </label>
            <NumberDraftInput
              id="timeout"
              min={0}
              value={localState.requestTimeoutSeconds}
              onCommit={(value) => commitNumericSetting("requestTimeoutSeconds", value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
            />
            <p className="text-[10px] text-[var(--color-text-muted)] leading-tight">
              0 disables the timeout. It starts after the first token, so prompt evaluation is not
              cut off.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Networking
          </h3>
          <div className="space-y-2">
            <label htmlFor="serverPort" className="text-sm font-medium">
              Bun Server Port
            </label>
            <NumberDraftInput
              id="serverPort"
              integer
              min={1}
              max={65535}
              value={localState.serverPort}
              onCommit={(value) => commitNumericSetting("serverPort", value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm font-mono focus:border-[var(--color-accent)] outline-none"
            />
            <p className="text-[10px] text-red-400 font-medium leading-tight">
              CAUTION: Changing this will disconnect the UI. Requires manual restart if changed
              beyond the dev proxy.
            </p>
          </div>
        </section>
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-xs text-[var(--color-text-muted)] flex items-center gap-2">
        {updateMut.isPending ? <Loader2 className="animate-spin" size={14} /> : null}
        <span>
          {updateMut.isError
            ? updateMut.error instanceof Error
              ? updateMut.error.message
              : "Failed to save settings."
            : updateMut.isPending
              ? "Saving settings..."
              : "Changes save automatically."}
        </span>
      </div>
    </div>
  );
}
