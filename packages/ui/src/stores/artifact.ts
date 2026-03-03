/**
 * Artifact Store
 *
 * Zustand store for managing artifact display state in the left panel.
 */

import { create } from 'zustand';

interface ArtifactState {
  currentUrl: string | null;
  history: string[];

  showArtifact: (url: string) => void;
  clearArtifact: () => void;
}

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  currentUrl: null,
  history: [],

  showArtifact: (url: string) => {
    const state = get();
    const history = state.currentUrl ? [...state.history, state.currentUrl] : state.history;
    set({ currentUrl: url, history });
  },

  clearArtifact: () => {
    set({ currentUrl: null });
  },
}));
