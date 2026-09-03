/**
 * @packageDocumentation
 * Left sidebar component for managing chat history: searching, sorting, renaming, deleting, and exporting sessions.
 */

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Check,
  Download,
  Edit2,
  FileUp,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { logError } from "../../logger";
import { useCreateChat, useDeleteChat, useInfiniteChats, useUpdateChat } from "../../queries";
import { useAppStore } from "../../store";

/**
 * Main sidebar component for chat navigation.
 * Displays a flat, sorted chat list with search and export controls.
 *
 * @returns React functional component.
 */
export function ChatSidebar() {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "name">("date");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const createLockRef = useRef(false);
  const deleteLockRef = useRef(false);
  const navigate = useNavigate();
  const { chatId } = useParams({ strict: false });

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteChats(search);
  const chats = useMemo(() => data?.pages.flat() || [], [data]);
  const chatsById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats]);

  const unloadChat = useAppStore((state) => state.unloadChat);
  const unreadChatIds = useAppStore((state) => state.unreadChatIds);
  const clearUnreadChat = useAppStore((state) => state.clearUnreadChat);
  const currentChatId = useAppStore((state) => state.currentChatId);
  const addNotification = useAppStore((state) => state.addNotification);

  const createMut = useCreateChat();
  const deleteMut = useDeleteChat();
  const updateMut = useUpdateChat();

  /**
   * Creates a new chat and navigates to it.
   *
   * @returns A promise that resolves once the create flow completes.
   */
  const handleCreateChat = async () => {
    if (createLockRef.current || createMut.isPending) return;
    createLockRef.current = true;
    try {
      const newChat = await createMut.mutateAsync({ name: "New Chat" });
      if (newChat?.id) {
        navigate({ to: "/chat/$chatId", params: { chatId: newChat.id } });
      }
    } catch (err: unknown) {
      logError("Create chat failed", err);
    } finally {
      createLockRef.current = false;
    }
  };

  /**
   * Enters inline rename mode for a chat row.
   *
   * @param id - Chat identifier being renamed.
   * @param name - Current chat name.
   * @param e - Mouse event from the rename button.
   * @returns No return value.
   */
  const handleStartRename = (id: string, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(id);
    setEditValue(name);
  };

  /**
   * Saves an inline chat rename.
   *
   * @param id - Chat identifier being renamed.
   * @param e - Mouse event from the save button.
   * @returns A promise that resolves once the rename mutation completes.
   */
  const handleSaveRename = async (id: string, e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await updateMut.mutateAsync({ id, updates: { name: editValue } });
    setEditingId(null);
  };

  /**
   * Deletes a chat after user confirmation and redirects when the active chat is removed.
   *
   * @param id - Chat identifier to delete.
   * @param e - Mouse event from the delete button.
   * @returns A promise that resolves once the delete flow completes.
   */
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (deleteLockRef.current || deleteMut.isPending) return;
    if (!confirm("Are you sure you want to delete this chat?")) return;

    const nextChatId = chatId === id ? chats.find((c) => c.id !== id)?.id : undefined;

    deleteLockRef.current = true;
    setPendingDeleteId(id);
    try {
      await deleteMut.mutateAsync(id);
      useAppStore.getState().discardPendingChatFrames(id);
      useAppStore.getState().clearUnreadChat(id);
      if (chatId === id) {
        unloadChat();
        if (nextChatId) {
          navigate({ to: "/chat/$chatId", params: { chatId: nextChatId } });
        } else {
          navigate({ to: "/" });
        }
      }
    } catch (err: unknown) {
      logError("Failed to delete chat", err);
      addNotification(err instanceof Error ? err.message : "Failed to delete chat.", "error");
    } finally {
      deleteLockRef.current = false;
      setPendingDeleteId(null);
    }
  };

  /**
   * Opens a specific chat in the main workspace.
   *
   * @param targetChatId - Chat identifier to open.
   * @returns No return value.
   */
  const handleOpenChat = (targetChatId: string) => {
    clearUnreadChat(targetChatId);
    navigate({ to: "/chat/$chatId", params: { chatId: targetChatId } });
  };

  /**
   * Navigates to the parent chat for a branch row.
   *
   * @param parentChatId - Parent chat identifier.
   * @param e - Mouse event from the parent-chat button.
   * @returns No return value.
   */
  const handleOpenParentChat = (parentChatId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handleOpenChat(parentChatId);
  };

  /**
   * Exports a single chat as JSON.
   *
   * @param id - Chat identifier to export.
   * @param e - Mouse event from the export button.
   * @returns A promise that resolves once the export download has been triggered.
   */
  const handleExport = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const res = await fetch(`/api/chats/${id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json" }),
    });
    if (res.ok) {
      const content = await res.text();
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `llama-chat-${id}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  /**
   * Exports the currently active chat as JSON.
   *
   * @returns A promise that resolves once the export download has been triggered.
   */
  const handleExportCurrentChat = async () => {
    if (!currentChatId) return;
    const res = await fetch(`/api/chats/${currentChatId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json" }),
    });
    if (res.ok) {
      const content = await res.text();
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `llama-chat-${currentChatId}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  const sortedChats = useMemo(() => {
    const filtered = chats.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
    if (sortBy === "name") {
      return filtered.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return filtered.slice().sort((a, b) => {
      const aDate = new Date(a.createdAt).getTime();
      const bDate = new Date(b.createdAt).getTime();
      if (bDate !== aDate) return bDate - aDate;
      return b.id.localeCompare(a.id);
    });
  }, [chats, search, sortBy]);

  if (isLoading) return <div className="w-64 border-r animate-pulse bg-[var(--color-bg)]" />;

  return (
    <div className="w-72 border-r border-[var(--color-border)] bg-[var(--color-bg)] flex flex-col h-full shrink-0 z-30">
      <div className="p-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            type="button"
            onClick={handleCreateChat}
            disabled={createMut.isPending}
            className={`flex-1 min-w-[140px] flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold shadow-sm transition-all active:scale-95 ${
              createMut.isPending
                ? "bg-[var(--color-border)] text-[var(--color-text-muted)] cursor-not-allowed"
                : "bg-[var(--color-accent)] text-white hover:opacity-90"
            }`}>
            <Plus size={18} />
            <span>New Chat</span>
          </button>

          <select
            aria-label="Sort chats"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "date" | "name")}
            className="bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-xl px-3 py-2 text-sm text-[var(--color-text-primary)] shadow-sm focus:outline-none focus:border-[var(--color-accent)] transition-all">
            <option value="date">Sort by date</option>
            <option value="name">Sort by name</option>
          </select>

          <button
            type="button"
            onClick={handleExportCurrentChat}
            disabled={!currentChatId}
            className="flex items-center justify-center gap-2 bg-[var(--color-surface-elevated)] text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-xl px-3 py-2 text-sm shadow-sm transition-all hover:bg-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed">
            <Download size={16} />
            <span>Export Chat</span>
          </button>

          <label
            className="flex items-center justify-center bg-[var(--color-surface-elevated)] hover:bg-[var(--color-border)] border border-[var(--color-border)] rounded-xl px-3 cursor-pointer transition-all text-[var(--color-text-primary)] shadow-sm"
            title="Import Chat">
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const content = await file.text();
                const res = await fetch("/api/chats/import", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ content }),
                });
                if (res.ok) {
                  const data = await res.json();
                  navigate({ to: "/chat/$chatId", params: { chatId: data.id } });
                }
              }}
            />
            <FileUp size={18} />
          </label>
        </div>

        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            placeholder="Search activity..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl pl-10 pr-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)] transition-all shadow-inner"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {sortedChats.map((c) => {
          const isActive = chatId === c.id;
          const parentChat = c.parentId ? chatsById.get(c.parentId) : undefined;

          const row = (
            <div
              key={c.id}
              data-status={isActive ? "active" : "idle"}
              className="group flex flex-col px-3 py-2.5 rounded-xl transition-all hover:bg-[var(--color-surface-elevated)] data-[status=active]:bg-[var(--color-accent)]/10 data-[status=active]:text-[var(--color-accent)]">
              <div className="flex items-center justify-between gap-2 overflow-hidden">
                <div className="flex flex-col min-w-0 flex-1">
                  {editingId === c.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="bg-[var(--color-bg)] border border-[var(--color-accent)] rounded px-1 py-0.5 text-sm w-full outline-none"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.key === "Enter" && handleSaveRename(c.id, e)}
                      />
                      <button
                        type="button"
                        onClick={(e) => handleSaveRename(c.id, e)}
                        className="p-1 hover:text-[var(--color-success)]">
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingId(null);
                        }}
                        className="p-1 hover:text-[var(--color-error)]">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <Link
                        to="/chat/$chatId"
                        params={{ chatId: c.id }}
                        onClick={() => clearUnreadChat(c.id)}
                        className="min-w-0 flex flex-col">
                        <span className="truncate font-medium text-sm leading-tight group-data-[status=active]:font-bold">
                          {c.isBranch && "🌿 "}
                          {c.name}
                        </span>
                        <span className="text-[10px] text-[var(--color-text-muted)] mt-0.5 flex items-center gap-2">
                          {new Date(c.createdAt).toLocaleString()}
                          {unreadChatIds.includes(c.id) && (
                            <span className="inline-flex items-center rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-bg)]">
                              New
                            </span>
                          )}
                        </span>
                      </Link>
                      {c.isBranch && c.parentId && (
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                          <span>Parent:</span>
                          <button
                            type="button"
                            onClick={(e) => handleOpenParentChat(c.parentId as string, e)}
                            className="truncate rounded px-1 py-0.5 text-left text-[var(--color-accent)] hover:bg-[var(--color-surface)]"
                            aria-label={`Open parent chat: ${parentChat?.name ?? c.parentId}`}>
                            {parentChat?.name ?? c.parentId}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {editingId !== c.id && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => handleStartRename(c.id, c.name, e)}
                      className="p-1.5 hover:bg-[var(--color-surface)] rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      title="Rename">
                      <Edit2 size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleExport(c.id, e)}
                      className="p-1.5 hover:bg-[var(--color-surface)] rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      title="Export">
                      <Download size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleDelete(c.id, e)}
                      disabled={pendingDeleteId !== null}
                      className="p-1.5 hover:bg-red-500/10 rounded-lg text-[var(--color-text-muted)] hover:text-red-400"
                      title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );

          return row;
        })}
        {sortedChats.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-[var(--color-text-muted)] opacity-50">
            <MessageSquare size={32} className="mb-2" />
            <p className="text-xs">Your transmission log is empty.</p>
          </div>
        )}

        {hasNextPage && (
          <button
            type="button"
            className="w-full text-xs text-center py-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] rounded-xl transition-all"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}>
            {isFetchingNextPage ? "Loading..." : "Load Older Chats"}
          </button>
        )}
      </div>
    </div>
  );
}
