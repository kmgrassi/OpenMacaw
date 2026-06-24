import { create } from "zustand";
import { persist } from "zustand/middleware";

type UiState = {
  debugMode: boolean;
  focusMode: boolean;
  sidebarWidth: number;
  toggleDebugMode: () => void;
  toggleFocusMode: () => void;
  setSidebarWidth: (width: number) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      debugMode: false,
      focusMode: false,
      sidebarWidth: 288,
      toggleDebugMode: () => set((state) => ({ debugMode: !state.debugMode })),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
    }),
    {
      name: "harper-openclaw-ui",
      partialize: (state) => ({
        debugMode: state.debugMode,
        focusMode: state.focusMode,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
);
