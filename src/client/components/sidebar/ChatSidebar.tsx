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
import { useMemo, useState } from "react";
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
  const navigate = useNavigate();
  const { chatId } = useParams({ strict: false });

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteChats(search);
  const chats = useMemo(() => data?.pages.flat() || [], [data]);

  const unloadChat = useAppStore((state) => state.unloadChat);
  const unreadChatIds = useAppStore((state) => state.unreadChatIds);
  const clearUnreadChat = useAppStore((state) => state.clearUnreadChat);
  const currentChatId = useAppStore((state) => state.currentChatId);

  const createMut = useCreateChat();
  const deleteMut = useDeleteChat();
  const updateMut = useUpdateChat();

  const handleCreateChat = async () => {
    const newChat = await createMut.mutateAsync({ name: "New Chat" });
    navigate({ to: "/chat/$chatId", params: { chatId: newChat.id } });
  };

  const handleStartRename = (id: string, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(id);
    setEditValue(name);
  };

  const handleSaveRename = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await updateMut.mutateAsync({ id, updates: { name: editValue } });
    setEditingId(null);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await deleteMut.mutateAsync(id);
    if (chatId === id) {
      unloadChat();
      navigate({ to: "/", params: {} });
    }
  };

  const handleExport = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const res = await fetch(`/api/chats/${id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json" }),
    });
    if (res.ok) {
      const { content } = await res.json();
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `llama-chat-${id}.json`;
      a.click();
    }
  };

  const handleExportCurrentChat = async () => {
    if (!currentChatId) return;
    const res = await fetch(`/api/chats/${currentChatId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json" }),
    });
    if (res.ok) {
      const { content } = await res.json();
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `llama-chat-${currentChatId}.json`;
      a.click();
    }
  };

  const sortedChats = useMemo(() => {
    const filtered = chats.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
    if (sortBy === "name") {
      return filtered.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return filtered.slice().sort((a, b) => {
      const aDate = new Date(a.updatedAt || a.createdAt).getTime();
      const bDate = new Date(b.updatedAt || b.createdAt).getTime();
      return bDate - aDate;
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
            className="flex-1 min-w-[140px] flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white hover:opacity-90 rounded-xl py-2.5 text-sm font-semibold shadow-sm transition-all active:scale-95">
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
        {sortedChats.map((c) => (
          <Link
            key={c.id}
            to="/chat/$chatId"
            params={{ chatId: c.id }}
            onClick={() => clearUnreadChat(c.id)}
            activeProps={{
              "data-status": "active",
            }}
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
                      onKeyDown={(e) => e.key === "Enter" && handleSaveRename(c.id, e as any)}
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
                  </>
                )}
              </div>
              {!editingId && (
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
                    className="p-1.5 hover:bg-red-500/10 rounded-lg text-[var(--color-text-muted)] hover:text-red-400"
                    title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          </Link>
        ))}
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
