/**
 * @packageDocumentation
 * Sidebar panel for editing global system instructions.
 * Uses CodeMirror with Markdown highlighting.
 */

import { markdown } from "@codemirror/lang-markdown";
import type { SystemPromptPreset } from "@shared/types.js";
import CodeMirror from "@uiw/react-codemirror";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useCreateSystemPreset,
  useDeleteSystemPreset,
  useSystemPresets,
  useUpdateChat,
  useUpdateSystemPreset,
} from "../../queries";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";

/**
 * Component for managing and editing system prompt presets.
 * Displays a searchable list of presets and a large Markdown editor.
 *
 * @returns React functional component.
 */
export function SystemPresetEditor() {
  const { setRightPanelView, activePresetId } = useUiStore();
  const { currentChatId, loadChat } = useAppStore();
  const { data: presets } = useSystemPresets();
  const createMut = useCreateSystemPreset();
  const updateMut = useUpdateSystemPreset();
  const deleteMut = useDeleteSystemPreset();
  const updateChatMut = useUpdateChat();

  const activePreset = presets?.find((p) => p.id === activePresetId) || presets?.[0];

  const [localState, setLocalState] = useState<Partial<SystemPromptPreset> | null>(null);

  useEffect(() => {
    if (!activePreset) return;
    setLocalState((prev) => (prev?.id === activePreset.id ? prev : activePreset));
  }, [activePreset]);

  if (!localState) return <div className="w-80 shrink-0 bg-[var(--color-surface)] border-l" />;

  const updateField = <K extends keyof SystemPromptPreset>(k: K, v: SystemPromptPreset[K]) => {
    setLocalState((prev) => (prev ? { ...prev, [k]: v } : null));
  };

  const handleApplyToChat = async () => {
    if (!currentChatId || !localState.id) return;
    await updateChatMut.mutateAsync({
      id: currentChatId,
      updates: { systemPresetId: localState.id },
    });
    await loadChat(currentChatId);
    setRightPanelView(null);
  };

  const handleSave = () => {
    if (!localState.id) return;
    updateMut.mutate({ id: localState.id, updates: localState });
  };

  const handleDuplicate = () => {
    if (!localState) return;
    const newPreset: SystemPromptPreset = {
      ...(localState as SystemPromptPreset),
      id: crypto.randomUUID(),
      name: `${localState.name} (Copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("systemPreset", newPreset.id);
  };

  const handleNew = () => {
    const newPreset: SystemPromptPreset = {
      id: crypto.randomUUID(),
      name: "New System Preset",
      content: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("systemPreset", newPreset.id);
  };

  const handleDelete = () => {
    if (!localState.id) return;
    deleteMut.mutate(localState.id);
    setRightPanelView("systemPreset", presets?.find((p) => p.id !== localState.id)?.id);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-96 shadow-xl overflow-hidden shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)] bg-[var(--color-surface-elevated)] gap-2">
        <div className="flex flex-col flex-1 min-w-0">
          <h2 className="font-semibold text-lg flex items-center gap-2 truncate">System Preset</h2>
          <select
            value={activePreset?.id || ""}
            onChange={(e) => setRightPanelView("systemPreset", e.target.value)}
            className="text-xs bg-transparent border-none text-[var(--color-text-muted)] outline-none focus:text-[var(--color-text-primary)] w-full truncate">
            <option value="" className="bg-[var(--color-surface)]">
              None
            </option>
            {presets?.map((p) => (
              <option key={p.id} value={p.id} className="bg-[var(--color-surface)]">
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handleNew}
            className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors"
            title="Create New">
            <Plus size={16} />
          </button>
          <button
            type="button"
            onClick={handleDuplicate}
            className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors"
            title="Duplicate">
            <Copy size={16} />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="p-1 hover:bg-red-900/30 text-red-400 rounded-md transition-colors"
            title="Delete">
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            onClick={() => setRightPanelView(null)}
            className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 flex flex-col space-y-4 overflow-y-auto">
        <div className="space-y-2">
          <label htmlFor="systemPresetName" className="text-sm font-medium">
            Preset Name
          </label>
          <input
            id="systemPresetName"
            type="text"
            value={localState.name || ""}
            onChange={(e) => updateField("name", e.target.value)}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-1.5 rounded-md"
          />
        </div>

        <div className="flex-1 space-y-2 flex flex-col">
          <label
            htmlFor="systemPromptInput"
            className="text-sm font-medium flex justify-between items-center">
            <span>System Prompt</span>
          </label>
          <div className="border border-[var(--color-border)] rounded-md overflow-hidden flex-1 flex flex-col min-h-[300px]">
            <CodeMirror
              id="systemPromptInput"
              value={localState.content || ""}
              extensions={[markdown()]}
              theme="dark"
              onChange={(val) => updateField("content", val)}
              className="text-sm flex-1 h-full"
              height="100%"
            />
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] flex flex-col gap-2">
        {currentChatId && (
          <button
            type="button"
            onClick={handleApplyToChat}
            disabled={updateChatMut.isPending}
            className="w-full flex items-center justify-center gap-2 bg-[#0ea5e9] text-white p-2 rounded-lg hover:shadow-md transition-all font-semibold text-sm">
            Use in Active Chat
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          className="w-full flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white p-2 rounded-lg hover:shadow-md active:scale-95 active:shadow-none transition-all font-semibold text-sm">
          <Save size={16} /> Save Changes
        </button>
      </div>
    </div>
  );
}
