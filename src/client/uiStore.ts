/**
 * @packageDocumentation
 * Secondary store for UI-specific state: sidebar visibility, console toggles, and active editor context.
 */

import { create } from "zustand";

/**
 * Valid views for the right-hand context sidebar.
 */
export type RightPanelView =
  | "loadPreset"
  | "inferencePreset"
  | "systemPreset"
  | "settings"
  | "modelLibrary";

/**
 * Interface for the UI state store.
 */
export interface UiState {
  /** The current active panel in the right sidebar. */
  rightPanelView: RightPanelView | null;
  /** The ID of the preset currently being edited in the sidebar. */
  activePresetId: string | null;
  /** Whether the bottom debug console is shown. */
  isConsoleVisible: boolean;
  /** Switches the right sidebar to a new view, optionally targeting a specific preset. */
  setRightPanelView: (view: RightPanelView | null, presetId?: string) => void;
  /** Toggles the debug console visibility. */
  toggleConsole: () => void;
}

/**
 * Store hook for UI state.
 */
export const useUiStore = create<UiState>((set) => ({
  rightPanelView: null,
  activePresetId: null,
  isConsoleVisible: false,
  setRightPanelView: (view, presetId) =>
    set({ rightPanelView: view, activePresetId: presetId || null }),
  toggleConsole: () => set((state) => ({ isConsoleVisible: !state.isConsoleVisible })),
}));
