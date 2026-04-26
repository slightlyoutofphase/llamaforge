/**
 * @packageDocumentation
 * Right sidebar panel for managing application-wide settings: theme, paths, and advanced flags.
 */

import type { AppSettings } from "@shared/types";
import { Loader2, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSettings, useUpdateSettings } from "./queries";
import { useAppStore } from "./store";
import { useUiStore } from "./uiStore";

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

  useEffect(() => {
    if (settings) {
      setLocalState(settings);
    }
  }, [settings]);

  const handleSave = () => {
    updateMut.mutate(localState, {
      onSuccess: () => {
        useAppStore.getState().fetchModels();
      },
    });
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
              placeholder="~/.llamaforge/models"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
            />
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
            <label htmlFor="fontSize" className="text-sm font-medium">
              Font Size (px)
            </label>
            <input
              id="fontSize"
              type="number"
              value={localState.fontSize || 14}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, fontSize: parseInt(e.target.value, 10) }))
              }
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm"
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
                value={localState.llamaPortRangeMin || 8080}
                onChange={(e) =>
                  setLocalState((prev) => ({
                    ...prev,
                    llamaPortRangeMin: parseInt(e.target.value, 10),
                  }))
                }
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
                value={localState.llamaPortRangeMax || 8099}
                onChange={(e) =>
                  setLocalState((prev) => ({
                    ...prev,
                    llamaPortRangeMax: parseInt(e.target.value, 10),
                  }))
                }
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
              value={localState.requestTimeoutSeconds || 60}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  requestTimeoutSeconds: parseInt(e.target.value, 10),
                }))
              }
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
              value={localState.serverPort || 11435}
              onChange={(e) =>
                setLocalState((prev) => ({ ...prev, serverPort: parseInt(e.target.value, 10) }))
              }
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm font-mono focus:border-[var(--color-accent)] outline-none"
            />
            <p className="text-[10px] text-red-400 font-medium leading-tight">
              CAUTION: Changing this will disconnect the UI. Requires manual restart if changed
              beyond the dev proxy.
            </p>
          </div>
        </section>
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
        <button
          type="button"
          onClick={handleSave}
          disabled={updateMut.isPending}
          className="flex items-center justify-center gap-2 w-full bg-[var(--color-accent)] text-white p-2 rounded-lg hover:shadow-md transition-all disabled:opacity-50">
          {updateMut.isPending ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <Save size={16} />
          )}
          Save Settings
        </button>
      </div>
    </div>
  );
}
