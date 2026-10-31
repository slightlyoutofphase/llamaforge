/**
 * @packageDocumentation
 * Sidebar panel for editing global system instructions.
 * Uses CodeMirror with Markdown highlighting.
 */

import { markdown } from "@codemirror/lang-markdown";
import type { SystemPromptPreset } from "../../../shared/types";
import CodeMirror from "@uiw/react-codemirror";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  allocateUniqueName,
  validatePresetName,
  duplicatePresetName,
  presetMenuLabels,
} from "../../../shared/presetNames";
import {
  useCreateSystemPreset,
  useDeleteSystemPreset,
  useSystemPresets,
  useUpdateChat,
  useUpdateSystemPreset,
} from "../../queries";
import {
  confirmDiscardUnsaved,
  PresetSaveStatus,
  presetDraftIsDirty,
  resolvePresetEditorState,
} from "../DraftInputs";
import { useAppStore } from "../../store";
import { useUiStore } from "../../uiStore";
import { useResolvedTheme } from "../../useResolvedTheme";

/**
 * Component for managing and editing system prompt presets.
 * Displays a searchable list of presets and a large Markdown editor.
 *
 * @returns React functional component.
 */
export function SystemPresetEditor() {
  const codeMirrorTheme = useResolvedTheme();
  const { setRightPanelView, activePresetId } = useUiStore();
  const currentChatId = useAppStore((state) => state.currentChatId);
  const { data: presets } = useSystemPresets();
  const createMut = useCreateSystemPreset();
  const updateMut = useUpdateSystemPreset();
  const deleteMut = useDeleteSystemPreset();
  const updateChatMut = useUpdateChat();

  const explicitNone = activePresetId === "";
  const activePreset = explicitNone
    ? undefined
    : activePresetId
      ? presets?.find((p) => p.id === activePresetId)
      : presets?.[0];

  const [localState, setLocalState] = useState<Partial<SystemPromptPreset> | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const pendingSavedJson = useRef<string | null>(null);

  useEffect(() => {
    if (!activePreset) {
      pendingSavedJson.current = null;
      setLocalState(null);
      return;
    }
    setLocalState((prev) => resolvePresetEditorState(prev, activePreset, pendingSavedJson));
  }, [activePreset]);

  /**
   * Updates a single system preset field within local editor state.
   *
   * @param k - Field name to update.
   * @param v - New field value.
   * @returns No return value.
   */
  const updateField = <K extends keyof SystemPromptPreset>(k: K, v: SystemPromptPreset[K]) => {
    setLocalState((prev) => (prev ? { ...prev, [k]: v } : null));
  };

  /**
   * Applies the current system preset to the active chat and closes the editor.
   *
   * @returns A promise that resolves once the chat has been updated and reloaded.
   */
  const handleApplyToChat = async () => {
    if (!currentChatId || !localState?.id) return;
    const nameError = validatePresetName(localState.name ?? "");
    if (nameError) {
      setSaveError(true);
      setSaveMessage(nameError);
      return;
    }
    const name = allocateUniqueName(
      localState.name ?? "",
      (presets ?? []).filter((preset) => preset.id !== localState.id).map((preset) => preset.name),
    );
    const next = { ...localState, name };
    try {
      await updateMut.mutateAsync({ id: localState.id, updates: next });
      setLocalState(next);
      await updateChatMut.mutateAsync({
        id: currentChatId,
        updates: { systemPresetId: localState.id },
      });
      useAppStore.getState().patchCurrentChatMetadata({ systemPresetId: localState.id });
      setSaveError(false);
      setSaveMessage("Saved and applied.");
      setRightPanelView(null);
    } catch (error: unknown) {
      setSaveError(true);
      setSaveMessage(error instanceof Error ? error.message : "Could not apply this preset.");
    }
  };

  /**
   * Persists the currently edited system prompt preset.
   *
   * @returns No return value.
   */
  const handleSave = () => {
    if (!localState?.id) return;
    const nameError = validatePresetName(localState.name ?? "");
    if (nameError) {
      setSaveError(true);
      setSaveMessage(nameError);
      return;
    }
    const name = allocateUniqueName(
      localState.name?.trim() ?? "",
      (presets ?? []).filter((preset) => preset.id !== localState.id).map((preset) => preset.name),
    );
    const next = { ...localState, name };
    setLocalState(next);
    pendingSavedJson.current = JSON.stringify(next);
    updateMut.mutate(
      { id: localState.id, updates: next },
      {
        onSuccess: () => {
          setSaveError(false);
          setSaveMessage("Saved.");
        },
        onError: (error: unknown) => {
          setSaveError(true);
          setSaveMessage(error instanceof Error ? error.message : "Save failed.");
        },
      },
    );
  };

  /**
   * Leaves the current system preset after confirming when the draft is dirty.
   *
   * @param nextId - Preset id to open. An empty string selects none.
   * @param close - Close the editor instead of switching presets.
   * @returns No return value.
   */
  const requestPresetChange = (nextId: string, close = false) => {
    if (!confirmDiscardUnsaved(presetDraftIsDirty(localState, activePreset))) return;
    setSaveMessage(null);
    if (close) {
      setRightPanelView("settings");
      return;
    }
    setRightPanelView("systemPreset", nextId);
  };

  /**
   * Duplicates the current system prompt preset and opens the clone for editing.
   *
   * @returns No return value.
   */
  const handleDuplicate = () => {
    if (!localState) return;
    const newPreset: SystemPromptPreset = {
      ...(localState as SystemPromptPreset),
      id: crypto.randomUUID(),
      name: duplicatePresetName(
        localState.name ?? "Preset",
        (presets ?? []).map((preset) => preset.name),
      ),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("systemPreset", newPreset.id);
  };

  /**
   * Creates a new empty system prompt preset.
   *
   * @returns No return value.
   */
  const handleNew = () => {
    const newPreset: SystemPromptPreset = {
      id: crypto.randomUUID(),
      name: allocateUniqueName(
        "New System Preset",
        (presets ?? []).map((preset) => preset.name),
      ),
      content: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    createMut.mutate(newPreset);
    setRightPanelView("systemPreset", newPreset.id);
  };

  const systemLabels = presetMenuLabels(
    (presets ?? []).map((preset) => ({
      id: preset.id,
      name: preset.name,
      isDefault: false,
    })),
  );

  /**
   * Deletes the currently selected system prompt preset.
   *
   * @returns No return value.
   */
  const handleDelete = () => {
    if (!localState?.id) return;
    if (!window.confirm(`Delete preset "${localState.name || "this preset"}"?`)) return;
    deleteMut.mutate(localState.id, {
      onSuccess: () => {
        setSaveError(false);
        setSaveMessage("Deleted.");
      },
      onError: (error: unknown) => {
        setSaveError(true);
        setSaveMessage(error instanceof Error ? error.message : "Delete failed.");
      },
    });
    setRightPanelView("systemPreset", presets?.find((p) => p.id !== localState.id)?.id ?? "");
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] border-l border-[var(--color-border)] w-96 shadow-xl overflow-hidden shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)] bg-[var(--color-surface-elevated)] gap-2">
        <div className="flex flex-col flex-1 min-w-0">
          <h2 className="font-semibold text-lg flex items-center gap-2 truncate">System Preset</h2>
          <select
            value={explicitNone ? "" : activePreset?.id || ""}
            onChange={(e) => requestPresetChange(e.target.value)}
            className="text-xs bg-transparent border-none text-[var(--color-text-muted)] outline-none focus:text-[var(--color-text-primary)] w-full truncate">
            <option value="" className="bg-[var(--color-surface)]">
              None
            </option>
            {presets?.map((p) => (
              <option key={p.id} value={p.id} className="bg-[var(--color-surface)]">
                {systemLabels.get(p.id) ?? p.name}
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
            onClick={() => requestPresetChange("", true)}
            className="p-1 hover:bg-[var(--color-surface-elevated)] rounded-md transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      {!localState ? (
        <div className="flex-1 p-4 flex flex-col items-center justify-center gap-3 text-center text-sm text-[var(--color-text-muted)]">
          <p>No system preset selected.</p>
          <p>Choose a preset above or create a new one.</p>
        </div>
      ) : (
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
                theme={codeMirrorTheme}
                onChange={(val) => updateField("content", val)}
                className="text-sm flex-1 h-full"
                height="100%"
              />
            </div>
          </div>
        </div>
      )}

      <div className="p-4 border-t border-[var(--color-border)] bg-[var(--color-surface-elevated)] flex flex-col gap-2">
        <PresetSaveStatus message={saveMessage} error={saveError} />
        {currentChatId && localState && (
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
          disabled={!localState}
          className="w-full flex items-center justify-center gap-2 bg-[var(--color-accent)] text-white p-2 rounded-lg hover:shadow-md active:scale-95 active:shadow-none transition-all font-semibold text-sm disabled:opacity-50">
          <Save size={16} /> Save Changes
        </button>
      </div>
    </div>
  );
}
