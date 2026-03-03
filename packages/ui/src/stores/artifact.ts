/**
 * Artifact Store
 *
 * Zustand store for managing artifact display state in the left panel.
 * Persists the current URL to localStorage so it survives page refreshes.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'system2:artifact-url';

interface ArtifactState {
  currentUrl: string | null;
  history: string[];

  showArtifact: (url: string) => void;
  clearArtifact: () => void;
}

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  currentUrl: localStorage.getItem(STORAGE_KEY),
  history: [],

  showArtifact: (url: string) => {
    const state = get();
    const history = state.currentUrl ? [...state.history, state.currentUrl] : state.history;
    // Strip cache-bust param for storage (base URL is enough to restore)
    const baseUrl = url.split('?')[0];
    localStorage.setItem(STORAGE_KEY, baseUrl);
    set({ currentUrl: url, history });
  },

  clearArtifact: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ currentUrl: null });
  },
}));
