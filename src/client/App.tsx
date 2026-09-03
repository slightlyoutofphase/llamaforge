/**
 * @packageDocumentation
 * Root application layout component.
 * Manages global connectivity, theme injection, keyboard shortcuts, and the primary three-column grid.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { MessageSquare, Server, Settings, Terminal } from "lucide-react";
import { useEffect, useRef } from "react";
import { ConsoleLog } from "./ConsoleLog";
import { ChatSidebar } from "./components/sidebar/ChatSidebar";
import { InferencePresetEditor } from "./components/preset/InferencePresetEditor";
import { LoadPresetEditor } from "./components/preset/LoadPresetEditor";
import { SystemPresetEditor } from "./components/preset/SystemPresetEditor";
import { ModelLibraryPanel } from "./components/sidebar/ModelLibraryPanel";
import { HardwareInfo } from "./HardwareInfo";
import { logError } from "./logger";
import { queryKeys, useCreateChat, useSettings } from "./queries";
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
  const connectWs = useAppStore((s) => s.connectWs);
  const disconnectWs = useAppStore((s) => s.disconnectWs);
  const fetchHardware = useAppStore((s) => s.fetchHardware);
  const fetchModels = useAppStore((s) => s.fetchModels);
  const fetchServerStatus = useAppStore((s) => s.fetchServerStatus);
  const serverStatus = useAppStore((s) => s.serverStatus);
  const isConnected = useAppStore((s) => s.isConnected);
  const errorMessage = useAppStore((s) => s.errorMessage);
  const errorActionLabel = useAppStore((s) => s.errorActionLabel);
  const errorAction = useAppStore((s) => s.errorAction);
  const clearError = useAppStore((s) => s.clearError);
  const notifications = useAppStore((s) => s.notifications);
  const removeNotification = useAppStore((s) => s.removeNotification);
  const unloadModel = useAppStore((s) => s.unloadModel);
  const currentChatId = useAppStore((s) => s.currentChatId);
  const { setRightPanelView, rightPanelView, toggleConsole, isConsoleVisible } = useUiStore();
  const { data: settings } = useSettings();
  const createChatMut = useCreateChat();
  const queryClient = useQueryClient();
  const didApplyStartupConsoleRef = useRef(false);
  const createWorkspaceLockRef = useRef(false);

  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = location.pathname.startsWith("/chat") ? "chat" : "models";

  /**
   * Opens the chat workspace, creating a new chat when no active chat exists yet.
   *
   * @returns A promise that resolves once navigation has been handled.
   */
  const handleOpenChatWorkspace = async () => {
    if (currentChatId) {
      navigate({ to: "/chat/$chatId", params: { chatId: currentChatId } });
      return;
    }

    if (createWorkspaceLockRef.current || createChatMut.isPending) {
      return;
    }

    createWorkspaceLockRef.current = true;
    try {
      const chat = await createChatMut.mutateAsync({ name: "New Chat" });
      if (chat?.id) {
        navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
      }
    } catch (error) {
      logError("Failed to open chat workspace", error);
    } finally {
      createWorkspaceLockRef.current = false;
    }
  };

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
    document.documentElement.style.fontSize = `${settings?.fontSize ?? 14}px`;
  }, [settings?.fontSize]);

  useEffect(() => {
    if (!settings || didApplyStartupConsoleRef.current) {
      return;
    }

    didApplyStartupConsoleRef.current = true;
    if (settings.showConsoleOnStartup) {
      useUiStore.setState({ isConsoleVisible: true });
    }
  }, [settings]);

  useEffect(() => {
    /**
     * Handles the console toggle keyboard shortcut.
     *
     * @param e - Global keyboard event.
     * @returns No return value.
     */
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
    /**
     * Invalidates cached preset queries after backend preset updates are broadcast.
     *
     * @returns No return value.
     */
    const handlePresetsInvalidate = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.presetsLoad() });
      queryClient.invalidateQueries({ queryKey: queryKeys.presetsInference() });
      queryClient.invalidateQueries({ queryKey: queryKeys.presetsSystem() });
    };
    const handleChatsInvalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["chats"] });
    };
    window.addEventListener("llamaforge:presets-invalidate", handlePresetsInvalidate);
    window.addEventListener("llamaforge:chats-invalidate", handleChatsInvalidate);
    return () => {
      window.removeEventListener("llamaforge:presets-invalidate", handlePresetsInvalidate);
      window.removeEventListener("llamaforge:chats-invalidate", handleChatsInvalidate);
    };
  }, [queryClient]);

  /**
   * Selects the currently active right-side panel content.
   *
   * @returns The React element to render in the right-side panel.
   */
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
        <button
          type="button"
          onClick={() => {
            void handleOpenChatWorkspace();
          }}
          disabled={!currentChatId && createChatMut.isPending}
          className={`p-3 rounded-xl transition-all ${activeTab === "chat" ? "bg-[var(--color-surface-elevated)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
          title="Chat Workspace">
          <MessageSquare size={22} />
        </button>

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
      <div className="flex-1 min-w-0 min-h-0 flex flex-col relative h-full">
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
            {serverStatus === "running" && (
              <button
                type="button"
                onClick={() => unloadModel()}
                className="rounded-xl border border-[var(--color-error)] text-[var(--color-error)] px-3 py-1 hover:bg-[var(--color-error)] hover:text-white transition-colors">
                Unload Model
              </button>
            )}
            <button
              type="button"
              onClick={() => (isConnected ? disconnectWs() : connectWs())}
              className="rounded-xl border border-[var(--color-border)] px-3 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-elevated)] transition-colors">
              {isConnected ? "Disconnect" : "Reconnect"}
            </button>
          </div>
        </header>

        <main className="flex-1 min-w-0 min-h-0 overflow-hidden relative flex flex-col">
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

          <div className="min-w-0 min-h-0 flex-1 flex flex-col">
            <Outlet />
          </div>
          {isConsoleVisible ? <ConsoleLog /> : null}

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
