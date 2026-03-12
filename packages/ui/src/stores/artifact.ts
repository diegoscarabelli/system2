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
  url: string;
  filePath: string;
  title: string;
}

interface ArtifactState {
  tabs: ArtifactTab[];
  activeTabId: string | null;
  catalogOpen: boolean;
  catalogVersion: number;
  agentsOpen: boolean;
  agentsVersion: number;
  agentContextPercents: Record<number, number | null>;

  openArtifact: (url: string, title?: string, filePath?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  reloadTab: (filePath: string, newUrl: string) => void;
  toggleCatalog: () => void;
  toggleAgents: () => void;
  incrementCatalogVersion: () => void;
  incrementAgentsVersion: () => void;
  updateAgentContext: (context: Record<number, number | null>) => void;
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
        return { tabs: data.tabs, activeTabId: data.activeTabId || data.tabs[0].id };
      }
    }
  } catch {
    // ignore
  }
  return { tabs: [], activeTabId: null };
}

function persistTabs(tabs: ArtifactTab[], activeTabId: string | null): void {
  // Reconstruct clean URLs from filePath (strips cache-bust params while preserving ?path=)
  const cleaned = tabs.map((t) => ({
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
  catalogVersion: 0,
  agentsOpen: false,
  agentsVersion: 0,
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

  incrementCatalogVersion: () => {
    set((state) => ({ catalogVersion: state.catalogVersion + 1 }));
  },

  incrementAgentsVersion: () => {
    set((state) => ({ agentsVersion: state.agentsVersion + 1 }));
  },

  updateAgentContext: (context: Record<number, number | null>) => {
    set({ agentContextPercents: context });
  },
}));
