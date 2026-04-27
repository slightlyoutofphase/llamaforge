/**
 * @packageDocumentation
 * Root application layout component.
 * Manages global connectivity, theme injection, keyboard shortcuts, and the primary three-column grid.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { MessageSquare, Server, Settings, Terminal } from "lucide-react";
import { useEffect } from "react";
import { ConsoleLog } from "./ConsoleLog";
import { InferencePresetEditor } from "./components/preset/InferencePresetEditor";
import { LoadPresetEditor } from "./components/preset/LoadPresetEditor";
import { SystemPresetEditor } from "./components/preset/SystemPresetEditor";
import { ChatSidebar } from "./components/sidebar/ChatSidebar";
import { ModelLibraryPanel } from "./components/sidebar/ModelLibraryPanel";
import { HardwareInfo } from "./HardwareInfo";
import { queryKeys, useSettings } from "./queries";
import { SettingsPanel } from "./SettingsPanel";
import { useAppStore } from "./store";
import { useUiStore } from "./uiStore";

/**
 * The main application shell.
 * Establishes the WebSocket connection on mount and handles responsive layout switching
 * between the Model Registry and Chat Workspace modes.
 *
 * @returns React functional component.
 */
export default function App() {
  const {
    connectWs,
    disconnectWs,
    fetchHardware,
    fetchModels,
    fetchServerStatus,
    serverStatus,
    isConnected,
    errorMessage,
    errorActionLabel,
    errorAction,
    clearError,
    notifications,
    removeNotification,
  } = useAppStore();
  const { setRightPanelView, rightPanelView, toggleConsole } = useUiStore();
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();

  const location = useLocation();
  const activeTab = location.pathname.startsWith("/chat") ? "chat" : "models";

  // S11 fix: Zustand store methods are stable references; run initialization once on mount only
  /* eslint-disable react-hooks/exhaustive-deps */
  // biome-ignore lint/correctness/useExhaustiveDependencies: Zustand methods are stable singletons
  useEffect(() => {
    connectWs();
    fetchHardware();
    fetchModels().then(() => fetchServerStatus());
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    const theme = settings?.theme || "system";
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "light") {
      root.classList.add("light");
    } else if (theme === "dark") {
      root.classList.add("dark");
    }
  }, [settings?.theme]);

  useEffect(() => {
    if (settings?.accentColor) {
      document.documentElement.style.setProperty("--color-accent", settings.accentColor);
    }
  }, [settings?.accentColor]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        toggleConsole();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleConsole]);

  useEffect(() => {
    const handlePresetsInvalidate = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.presetsLoad() });
      queryClient.invalidateQueries({ queryKey: queryKeys.presetsInference() });
    };
    window.addEventListener("llamaforge:presets-invalidate", handlePresetsInvalidate);
    return () =>
      window.removeEventListener("llamaforge:presets-invalidate", handlePresetsInvalidate);
  }, [queryClient]);

  const renderRightPanel = () => {
    if (rightPanelView === "settings") return <SettingsPanel />;
    if (rightPanelView === "inferencePreset") return <InferencePresetEditor />;
    if (rightPanelView === "loadPreset") return <LoadPresetEditor />;
    if (rightPanelView === "systemPreset") return <SystemPresetEditor />;
    if (rightPanelView === "modelLibrary") return <ModelLibraryPanel />;
    if (rightPanelView === null) return <HardwareInfo />;
    return null;
  };

  return (
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text-primary)] font-sans antialiased overflow-hidden">
      {/* Sidebar */}
      <div className="w-16 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col items-center py-4 space-y-6 z-10 relative">
        <div className="text-[var(--color-accent)] font-bold text-xl mb-4" title="LlamaForge">
          LF
        </div>

        <Link
          to="/"
          className={`p-3 rounded-xl transition-all ${activeTab === "models" ? "bg-[var(--color-surface-elevated)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
          title="Models">
          <Server size={22} />
        </Link>
        <Link
          to="/chat/$chatId"
          params={{ chatId: "default-chat" }}
          className={`p-3 rounded-xl transition-all ${activeTab === "chat" ? "bg-[var(--color-surface-elevated)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
          title="Chat Workspace">
          <MessageSquare size={22} />
        </Link>

        <div className="flex-grow" />

        <div
          className={`w-3 h-3 rounded-full ${isConnected ? "bg-[var(--color-success)]" : "bg-[var(--color-error)]"}`}
          title={isConnected ? "Connected to core" : "Disconnected"}
        />

        <button
          type="button"
          onClick={toggleConsole}
          className="p-3 rounded-xl transition-all text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          title="Toggle Console (Ctrl+`)">
          <Terminal size={22} />
        </button>

        <button
          type="button"
          title="Settings"
          onClick={() => setRightPanelView(rightPanelView === "settings" ? null : "settings")}
          className={`p-3 rounded-xl transition-all ${rightPanelView === "settings" ? "bg-[var(--color-surface-elevated)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}>
          <Settings size={22} />
        </button>
      </div>

      {activeTab === "chat" && <ChatSidebar />}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col relative h-full">
        <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 bg-[var(--color-surface)] justify-between shrink-0">
          <div className="flex items-center gap-4">
            <h1 className="font-semibold">
              {activeTab === "models" ? "Model Registry" : "Chat Workspace"}
            </h1>
          </div>
          <div className="flex items-center space-x-4 text-sm font-mono text-[var(--color-text-secondary)]">
            <span>
              Status:{" "}
              <span
                className={
                  serverStatus === "running"
                    ? "text-[var(--color-success)]"
                    : "text-[var(--color-warning)]"
                }>
                {serverStatus}
              </span>
            </span>
            <button
              type="button"
              onClick={() => (isConnected ? disconnectWs() : connectWs())}
              className="rounded-xl border border-[var(--color-border)] px-3 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-elevated)] transition-colors">
              {isConnected ? "Disconnect" : "Reconnect"}
            </button>
          </div>
        </header>

        <main className="flex-1 min-w-0 overflow-hidden relative flex flex-col">
          {errorMessage ? (
            <div className="shrink-0 relative z-20 p-4 bg-[var(--color-error)] text-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-md">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{errorMessage}</div>
              </div>
              <div className="flex items-center gap-2">
                {errorActionLabel && errorAction ? (
                  <button
                    type="button"
                    onClick={() => {
                      errorAction();
                      clearError();
                    }}
                    className="px-3 py-1.5 rounded-xl bg-white text-[var(--color-error)] text-xs font-semibold hover:bg-white/90 transition-colors">
                    {errorActionLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={clearError}
                  className="text-xs uppercase tracking-widest font-semibold underline underline-offset-2">
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          <div className="min-w-0 flex-1">
            <Outlet />
          </div>
          <ConsoleLog />

          <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-3">
            {notifications.map((notification) => {
              const base =
                notification.type === "success"
                  ? "border-[var(--color-success)] bg-[#0f412954]"
                  : notification.type === "info"
                    ? "border-[#3b82f6] bg-[#eff6ff]"
                    : "border-[#ef4444] bg-[#fef2f2]";
              const text =
                notification.type === "success"
                  ? "text-[var(--color-success)]"
                  : notification.type === "info"
                    ? "text-[#1d4ed8]"
                    : "text-[#b91c1c]";

              return (
                <div
                  key={notification.id}
                  className={`w-[320px] rounded-2xl border shadow-xl overflow-hidden ${base} ${text}`}>
                  <div className="flex items-center justify-between px-4 py-3 gap-2">
                    <span className="text-sm leading-snug">{notification.message}</span>
                    <button
                      type="button"
                      onClick={() => removeNotification(notification.id)}
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] text-sm">
                      ×
                    </button>
                  </div>
                  {notification.actionLabel && notification.action ? (
                    <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-bg)]">
                      <button
                        type="button"
                        onClick={() => {
                          notification.action?.();
                          removeNotification(notification.id);
                        }}
                        className="w-full rounded-xl bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-dim)] transition-colors">
                        {notification.actionLabel}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </main>
      </div>

      {/* Hardware / Right Panel */}
      {renderRightPanel()}
    </div>
  );
}
