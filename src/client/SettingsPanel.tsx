/**
 * @packageDocumentation
 * Right sidebar panel for managing application-wide settings: theme, paths, and advanced flags.
 */

import type { AppSettings } from "@shared/types";
import { FolderOpen, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSettings, useUpdateSettings } from "./queries";
import { useAppStore } from "./store";
import { useUiStore } from "./uiStore";

type NumericDraftKey =
  "llamaPortRangeMin" | "llamaPortRangeMax" | "requestTimeoutSeconds" | "serverPort";

type NumericDraftState = Record<NumericDraftKey, string>;

const NUMERIC_DEFAULTS: NumericDraftState = {
  llamaPortRangeMin: "12000",
  llamaPortRangeMax: "13000",
  requestTimeoutSeconds: "60",
  serverPort: "11435",
};

/**
 * Builds the editable string drafts used by numeric settings inputs.
 *
 * @param settings - Persisted settings values used to seed the input controls.
 * @returns A normalized set of string values for the numeric draft fields.
 */
function createNumericDrafts(settings?: Partial<AppSettings>): NumericDraftState {
  return {
    llamaPortRangeMin: String(settings?.llamaPortRangeMin ?? NUMERIC_DEFAULTS.llamaPortRangeMin),
    llamaPortRangeMax: String(settings?.llamaPortRangeMax ?? NUMERIC_DEFAULTS.llamaPortRangeMax),
    requestTimeoutSeconds: String(
      settings?.requestTimeoutSeconds ?? NUMERIC_DEFAULTS.requestTimeoutSeconds,
    ),
    serverPort: String(settings?.serverPort ?? NUMERIC_DEFAULTS.serverPort),
  };
}

/**
 * Returns the full path to an executable inside a directory, appending `.exe`
 * on Windows and using the correct path separator.
 *
 * @param dirPath - Directory selected by the user.
 * @param baseName - Executable name without extension.
 * @returns Combined path string.
 */
function getExecutablePath(dirPath: string, baseName: string): string {
  const isWindows = dirPath.includes("\\");
  const sep = isWindows ? "\\" : "/";
  const fileName = isWindows ? `${baseName}.exe` : baseName;
  return dirPath.endsWith(sep) ? dirPath + fileName : dirPath + sep + fileName;
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
  const [numericDrafts, setNumericDrafts] = useState<NumericDraftState>(NUMERIC_DEFAULTS);
  const lastPersistedStateRef = useRef<Partial<AppSettings> | null>(null);
  const hasHydratedRef = useRef(false);
  const saveTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (settings) {
      setLocalState(settings);
      setNumericDrafts(createNumericDrafts(settings));
      lastPersistedStateRef.current = settings;
      hasHydratedRef.current = true;
    }
  }, [settings]);

  /**
   * Updates a draft integer field and mirrors valid values into persisted settings state.
   *
   * @param key - Integer settings field being edited.
   * @param rawValue - Raw string value from the input control.
   * @returns No return value.
   */
  const updateIntegerDraft = (
    key: "llamaPortRangeMin" | "llamaPortRangeMax" | "serverPort",
    rawValue: string,
  ) => {
    setNumericDrafts((prev) => ({ ...prev, [key]: rawValue }));
    const trimmed = rawValue.trim();
    if (!/^\d+$/.test(trimmed)) {
      return;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return;
    }

    setLocalState((prev) => {
      if (key === "llamaPortRangeMin") {
        const currentMax =
          prev.llamaPortRangeMax ?? Number.parseInt(NUMERIC_DEFAULTS.llamaPortRangeMax, 10);
        if (parsed > currentMax) return prev;
      }
      if (key === "llamaPortRangeMax") {
        const currentMin =
          prev.llamaPortRangeMin ?? Number.parseInt(NUMERIC_DEFAULTS.llamaPortRangeMin, 10);
        if (parsed < currentMin) return prev;
      }
      return { ...prev, [key]: parsed };
    });
  };

  /**
   * Updates the request-timeout draft field and mirrors valid values into persisted settings state.
   *
   * @param rawValue - Raw string value from the timeout input.
   * @returns No return value.
   */
  const updateTimeoutDraft = (rawValue: string) => {
    setNumericDrafts((prev) => ({ ...prev, requestTimeoutSeconds: rawValue }));
    const trimmed = rawValue.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      return;
    }

    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    setLocalState((prev) => ({ ...prev, requestTimeoutSeconds: parsed }));
  };

  useEffect(() => {
    if (!hasHydratedRef.current || !lastPersistedStateRef.current) {
      return;
    }

    if (JSON.stringify(localState) === JSON.stringify(lastPersistedStateRef.current)) {
      return;
    }

    const pendingState = localState;
    const previousState = lastPersistedStateRef.current;
    const timeoutId = window.setTimeout(() => {
      updateMut.mutate(pendingState, {
        onSuccess: () => {
          if (previousState?.modelsPath !== pendingState.modelsPath) {
            void useAppStore.getState().fetchModels();
          }
          lastPersistedStateRef.current = pendingState;
        },
      });
    }, 250);
    saveTimeoutRef.current = timeoutId;

    return () => window.clearTimeout(timeoutId);
  }, [localState, updateMut]);

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
            <div className="flex gap-2">
              <input
                id="llamaServerPath"
                type="text"
                value={localState.llamaServerPath || ""}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, llamaServerPath: e.target.value }))
                }
                placeholder="/usr/local/bin/llama-server"
                className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
              <button
                type="button"
                aria-label="Browse for llama-server"
                onClick={async () => {
                  try {
                    if ("showDirectoryPicker" in window) {
                      const handle = await (window as any).showDirectoryPicker();
                      const dirPath = (handle as any).path || handle.name;
                      const filePath = getExecutablePath(dirPath, "llama-server");
                      setLocalState((prev) => ({ ...prev, llamaServerPath: filePath }));
                    }
                  } catch {
                    // User cancelled or API unavailable — ignore
                  }
                }}
                className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                <FolderOpen size={14} />
                Browse
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="modelsPath" className="text-sm font-medium">
              Models root directory
            </label>
            <div className="flex gap-2">
              <input
                id="modelsPath"
                type="text"
                value={localState.modelsPath || ""}
                onChange={(e) => setLocalState((prev) => ({ ...prev, modelsPath: e.target.value }))}
                placeholder="~/.llamaforge/models"
                className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
              />
              <button
                type="button"
                aria-label="Browse for models directory"
                onClick={async () => {
                  try {
                    if ("showDirectoryPicker" in window) {
                      const handle = await (window as any).showDirectoryPicker();
                      const dirPath = (handle as any).path || handle.name;
                      setLocalState((prev) => ({ ...prev, modelsPath: dirPath }));
                    }
                  } catch {
                    // User cancelled or API unavailable — ignore
                  }
                }}
                className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                <FolderOpen size={14} />
                Browse
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                if (saveTimeoutRef.current !== null) {
                  window.clearTimeout(saveTimeoutRef.current);
                  saveTimeoutRef.current = null;
                }
                const pendingState = localState;
                updateMut.mutate(pendingState, {
                  onSuccess: () => {
                    lastPersistedStateRef.current = pendingState;
                    void useAppStore.getState().rescanModels();
                  },
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
              <div className="flex gap-2">
                <input
                  id="nvidiaSmiPath"
                  type="text"
                  value={localState.nvidiaSmiPath || ""}
                  onChange={(e) =>
                    setLocalState((prev) => ({ ...prev, nvidiaSmiPath: e.target.value }))
                  }
                  placeholder="nvidia-smi"
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                />
                <button
                  type="button"
                  aria-label="Browse for nvidia-smi"
                  onClick={async () => {
                    try {
                      if ("showDirectoryPicker" in window) {
                        const handle = await (window as any).showDirectoryPicker();
                        const dirPath = (handle as any).path || handle.name;
                        const filePath = getExecutablePath(dirPath, "nvidia-smi");
                        setLocalState((prev) => ({ ...prev, nvidiaSmiPath: filePath }));
                      }
                    } catch {
                      // User cancelled or API unavailable — ignore
                    }
                  }}
                  className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="rocmSmiPath" className="text-sm font-medium">
                rocm-smi Path (Optional)
              </label>
              <div className="flex gap-2">
                <input
                  id="rocmSmiPath"
                  type="text"
                  value={localState.rocmSmiPath || ""}
                  onChange={(e) =>
                    setLocalState((prev) => ({ ...prev, rocmSmiPath: e.target.value }))
                  }
                  placeholder="rocm-smi"
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                />
                <button
                  type="button"
                  aria-label="Browse for rocm-smi"
                  onClick={async () => {
                    try {
                      if ("showDirectoryPicker" in window) {
                        const handle = await (window as any).showDirectoryPicker();
                        const dirPath = (handle as any).path || handle.name;
                        const filePath = getExecutablePath(dirPath, "rocm-smi");
                        setLocalState((prev) => ({ ...prev, rocmSmiPath: filePath }));
                      }
                    } catch {
                      // User cancelled or API unavailable — ignore
                    }
                  }}
                  className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="sysctlPath" className="text-sm font-medium">
                sysctl Path (Optional)
              </label>
              <div className="flex gap-2">
                <input
                  id="sysctlPath"
                  type="text"
                  value={localState.sysctlPath || ""}
                  onChange={(e) =>
                    setLocalState((prev) => ({ ...prev, sysctlPath: e.target.value }))
                  }
                  placeholder="sysctl"
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                />
                <button
                  type="button"
                  aria-label="Browse for sysctl"
                  onClick={async () => {
                    try {
                      if ("showDirectoryPicker" in window) {
                        const handle = await (window as any).showDirectoryPicker();
                        const dirPath = (handle as any).path || handle.name;
                        const filePath = getExecutablePath(dirPath, "sysctl");
                        setLocalState((prev) => ({ ...prev, sysctlPath: filePath }));
                      }
                    } catch {
                      // User cancelled or API unavailable — ignore
                    }
                  }}
                  className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="systemProfilerPath" className="text-sm font-medium">
                system_profiler Path (Optional)
              </label>
              <div className="flex gap-2">
                <input
                  id="systemProfilerPath"
                  type="text"
                  value={localState.systemProfilerPath || ""}
                  onChange={(e) =>
                    setLocalState((prev) => ({ ...prev, systemProfilerPath: e.target.value }))
                  }
                  placeholder="system_profiler"
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                />
                <button
                  type="button"
                  aria-label="Browse for system_profiler"
                  onClick={async () => {
                    try {
                      if ("showDirectoryPicker" in window) {
                        const handle = await (window as any).showDirectoryPicker();
                        const dirPath = (handle as any).path || handle.name;
                        const filePath = getExecutablePath(dirPath, "system_profiler");
                        setLocalState((prev) => ({ ...prev, systemProfilerPath: filePath }));
                      }
                    } catch {
                      // User cancelled or API unavailable — ignore
                    }
                  }}
                  className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="powershellPath" className="text-sm font-medium">
                PowerShell Path (Optional)
              </label>
              <div className="flex gap-2">
                <input
                  id="powershellPath"
                  type="text"
                  value={localState.powershellPath || ""}
                  onChange={(e) =>
                    setLocalState((prev) => ({ ...prev, powershellPath: e.target.value }))
                  }
                  placeholder="powershell"
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                />
                <button
                  type="button"
                  aria-label="Browse for powershell"
                  onClick={async () => {
                    try {
                      if ("showDirectoryPicker" in window) {
                        const handle = await (window as any).showDirectoryPicker();
                        const dirPath = (handle as any).path || handle.name;
                        const filePath = getExecutablePath(dirPath, "powershell");
                        setLocalState((prev) => ({ ...prev, powershellPath: filePath }));
                      }
                    } catch {
                      // User cancelled or API unavailable — ignore
                    }
                  }}
                  className="px-2 py-1.5 bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-bg)] transition-colors text-xs font-medium flex items-center gap-1">
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
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
              onChange={(e) => setLocalState((prev) => ({ ...prev, theme: e.target.value as any }))}
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
              Autoload Last Model
            </label>
            <input
              id="autoloadToggle"
              type="checkbox"
              checked={!!localState.autoloadLastModel}
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
                  value={localState.accentColor || "#3b82f6"}
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
                setLocalState((prev) => ({ ...prev, chatBubbleStyle: e.target.value as any }))
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
          <div className="space-y-2">
            <label htmlFor="logLevel" className="text-sm font-medium">
              Log Level
            </label>
            <select
              id="logLevel"
              value={localState.logLevel || "info"}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, logLevel: e.target.value as any }))
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
              <input
                id="portMin"
                type="number"
                value={numericDrafts.llamaPortRangeMin}
                onChange={(e) => updateIntegerDraft("llamaPortRangeMin", e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="portMax" className="text-sm font-medium line-clamp-1">
                Llama Port Max
              </label>
              <input
                id="portMax"
                type="number"
                value={numericDrafts.llamaPortRangeMax}
                onChange={(e) => updateIntegerDraft("llamaPortRangeMax", e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="timeout" className="text-sm font-medium">
              Request Timeout (sec)
            </label>
            <input
              id="timeout"
              type="number"
              value={numericDrafts.requestTimeoutSeconds}
              onChange={(e) => updateTimeoutDraft(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
            />
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
            <input
              id="serverPort"
              type="number"
              value={numericDrafts.serverPort}
              onChange={(e) => updateIntegerDraft("serverPort", e.target.value)}
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
        <span>{updateMut.isPending ? "Saving settings..." : "Changes save automatically."}</span>
      </div>
    </div>
  );
}
