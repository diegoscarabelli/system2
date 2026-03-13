/**
 * Artifact Store
 *
 * Zustand store for managing tabbed artifact display state.
 * Persists open tabs to localStorage so they survive page refreshes.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'system2:artifact-tabs';

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
  agentContextPercents: Record<number, number | null>;

  openArtifact: (url: string, title?: string, filePath?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  reloadTab: (filePath: string, newUrl: string) => void;
  toggleCatalog: () => void;
  toggleAgents: () => void;
  updateAgentContext: (context: Record<number, number | null>) => void;
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

function loadTabs(): { tabs: ArtifactTab[]; activeTabId: string | null } {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      if (Array.isArray(data.tabs) && data.tabs.length > 0) {
        const tabs = data.tabs.map((t: ArtifactTab) => ({
          ...t,
          type: (t.type ?? 'iframe') as 'iframe' | 'native',
        }));
        return { tabs, activeTabId: data.activeTabId || tabs[0].id };
      }
    }
  } catch {
    // ignore
  }
  return { tabs: [], activeTabId: null };
}

function persistTabs(tabs: ArtifactTab[], activeTabId: string | null): void {
  // Skip native tabs (transient — not persisted across page loads)
  const toSave = tabs.filter((t) => (t.type ?? 'iframe') !== 'native');
  // Reconstruct clean URLs from filePath (strips cache-bust params while preserving ?path=)
  const cleaned = toSave.map((t) => ({
    ...t,
    url: `/api/artifact?path=${encodeURIComponent(t.filePath)}`,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: cleaned, activeTabId }));
}

const initial = loadTabs();

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,
  catalogOpen: false,
  agentsOpen: false,
  agentContextPercents: {},

  openArtifact: (url: string, title?: string, filePath?: string) => {
    const state = get();
    const fp = filePath || extractFilePath(url);

    // If tab with same filePath exists, activate it and update URL
    const existing = state.tabs.find((t) => t.filePath === fp);
    if (existing) {
      const tabs = state.tabs.map((t) => (t.id === existing.id ? { ...t, url } : t));
      persistTabs(tabs, existing.id);
      set({ tabs, activeTabId: existing.id });
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
    const tabs = [...state.tabs, tab];
    persistTabs(tabs, tab.id);
    set({ tabs, activeTabId: tab.id });
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

    persistTabs(tabs, activeTabId);
    set({ tabs, activeTabId });
  },

  setActiveTab: (tabId: string) => {
    const state = get();
    persistTabs(state.tabs, tabId);
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

  updateAgentContext: (context: Record<number, number | null>) => {
    set({ agentContextPercents: context });
  },

  openKanbanTab: () => {
    const state = get();
    const existing = state.tabs.find((t) => t.component === 'kanban');
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: ArtifactTab = {
      id: 'kanban',
      type: 'native',
      component: 'kanban',
      url: '',
      filePath: '__kanban__',
      title: 'Board',
    };
    set({ tabs: [tab, ...state.tabs], activeTabId: 'kanban' });
  },

  toggleKanbanTab: () => {
    const state = get();
    const existing = state.tabs.find((t) => t.component === 'kanban');
    if (existing) {
      state.closeTab(existing.id);
    } else {
      state.openKanbanTab();
    }
  },
}));
