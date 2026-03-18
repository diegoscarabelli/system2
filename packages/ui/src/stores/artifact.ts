/**
 * Artifact Store
 *
 * Zustand store for managing tabbed artifact display state.
 * Persists open tabs, panel state, and board visibility to localStorage
 * via the Zustand persist middleware.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ArtifactTab {
  id: string;
  type: 'iframe' | 'native';
  component?: 'kanban';
  url: string;
  filePath: string;
  title: string;
}

interface ArtifactState {
  tabs: ArtifactTab[];
  activeTabId: string | null;
  catalogOpen: boolean;
  agentsOpen: boolean;
  kanbanOpen: boolean;
  openArtifact: (url: string, title?: string, filePath?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  reloadTab: (filePath: string, newUrl: string) => void;
  toggleCatalog: () => void;
  toggleAgents: () => void;
  openKanbanTab: () => void;
  toggleKanbanTab: () => void;
}

function extractFilePath(url: string): string {
  try {
    const match = url.match(/[?&]path=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch {
    // ignore
  }
  return url.split('?')[0];
}

function extractTitle(url: string): string {
  const fp = extractFilePath(url);
  const parts = fp.split('/');
  return parts[parts.length - 1] || 'Untitled';
}

const KANBAN_TAB: ArtifactTab = {
  id: 'kanban',
  type: 'native',
  component: 'kanban',
  url: '',
  filePath: '__kanban__',
  title: 'Board',
};

export const useArtifactStore = create<ArtifactState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      catalogOpen: false,
      agentsOpen: false,
      kanbanOpen: false,

      openArtifact: (url: string, title?: string, filePath?: string) => {
        const state = get();
        const fp = filePath || extractFilePath(url);

        // If tab with same filePath exists, activate it and update URL
        const existing = state.tabs.find((t) => t.filePath === fp);
        if (existing) {
          set({
            tabs: state.tabs.map((t) => (t.id === existing.id ? { ...t, url } : t)),
            activeTabId: existing.id,
          });
          return;
        }

        // Create new tab
        const tab: ArtifactTab = {
          id: `tab-${Date.now()}`,
          type: 'iframe',
          url,
          filePath: fp,
          title: title || extractTitle(url),
        };
        set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
      },

      closeTab: (tabId: string) => {
        const state = get();
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;

        const tabs = state.tabs.filter((t) => t.id !== tabId);
        let activeTabId = state.activeTabId;

        if (activeTabId === tabId) {
          // Activate adjacent tab
          if (tabs.length === 0) {
            activeTabId = null;
          } else if (idx < tabs.length) {
            activeTabId = tabs[idx].id;
          } else {
            activeTabId = tabs[tabs.length - 1].id;
          }
        }

        if (tabId === 'kanban') {
          set({ tabs, activeTabId, kanbanOpen: false });
        } else {
          set({ tabs, activeTabId });
        }
      },

      setActiveTab: (tabId: string) => {
        set({ activeTabId: tabId });
      },

      reloadTab: (filePath: string, newUrl: string) => {
        const state = get();
        const tabs = state.tabs.map((t) => (t.filePath === filePath ? { ...t, url: newUrl } : t));
        set({ tabs });
      },

      toggleCatalog: () => {
        set((state) => ({ catalogOpen: !state.catalogOpen, agentsOpen: false }));
      },

      toggleAgents: () => {
        set((state) => ({ agentsOpen: !state.agentsOpen, catalogOpen: false }));
      },

      openKanbanTab: () => {
        const state = get();
        if (state.kanbanOpen) {
          set({ activeTabId: 'kanban' });
          return;
        }
        set({ tabs: [KANBAN_TAB, ...state.tabs], activeTabId: 'kanban', kanbanOpen: true });
      },

      toggleKanbanTab: () => {
        const state = get();
        if (state.kanbanOpen) {
          state.closeTab('kanban');
        } else {
          state.openKanbanTab();
        }
      },
    }),
    {
      name: 'system2:artifact-store',
      partialize: (state) => ({
        // Exclude native tabs (kanban is reconstructed via kanbanOpen on load)
        tabs: state.tabs
          .filter((t) => t.type !== 'native')
          .map((t) => ({ ...t, url: `/api/artifact?path=${encodeURIComponent(t.filePath)}` })),
        activeTabId: state.activeTabId,
        agentsOpen: state.agentsOpen,
        kanbanOpen: state.kanbanOpen,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<ArtifactState>;
        const merged = { ...currentState, ...persisted };
        // Re-add the kanban tab to the tabs array if it was open
        if (persisted.kanbanOpen) {
          merged.tabs = [KANBAN_TAB, ...(persisted.tabs ?? [])];
        }
        return merged;
      },
    }
  )
);
