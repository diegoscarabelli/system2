/**
 * Artifact Store Tests
 *
 * Tests for kanban tab open/close/toggle behavior and kanbanOpen flag sync.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useArtifactStore } from './artifact';

function resetStore() {
  useArtifactStore.setState({
    tabs: [],
    activeTabId: null,
    catalogOpen: false,
    agentsOpen: false,
    kanbanOpen: false,
  });
}

describe('useArtifactStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('openKanbanTab', () => {
    it('adds kanban tab and sets kanbanOpen to true', () => {
      useArtifactStore.getState().openKanbanTab();

      const state = useArtifactStore.getState();
      expect(state.kanbanOpen).toBe(true);
      expect(state.tabs.some((t) => t.component === 'kanban')).toBe(true);
      expect(state.activeTabId).toBe('kanban');
    });

    it('does not add a second kanban tab if already open', () => {
      useArtifactStore.getState().openKanbanTab();
      useArtifactStore.getState().openKanbanTab();

      const state = useArtifactStore.getState();
      expect(state.tabs.filter((t) => t.component === 'kanban')).toHaveLength(1);
    });

    it('activates the existing kanban tab if already open', () => {
      useArtifactStore.getState().openKanbanTab();
      // Open another tab and make it active
      useArtifactStore.setState({ activeTabId: 'other' });

      useArtifactStore.getState().openKanbanTab();

      expect(useArtifactStore.getState().activeTabId).toBe('kanban');
    });
  });

  describe('closeTab (kanban)', () => {
    it('sets kanbanOpen to false when the kanban tab is closed', () => {
      useArtifactStore.getState().openKanbanTab();
      expect(useArtifactStore.getState().kanbanOpen).toBe(true);

      useArtifactStore.getState().closeTab('kanban');

      expect(useArtifactStore.getState().kanbanOpen).toBe(false);
      expect(useArtifactStore.getState().tabs.some((t) => t.component === 'kanban')).toBe(false);
    });

    it('does not set kanbanOpen to false when closing a non-kanban tab', () => {
      useArtifactStore.getState().openKanbanTab();
      useArtifactStore.setState({
        tabs: [
          ...useArtifactStore.getState().tabs,
          {
            id: 'tab-1',
            type: 'iframe',
            url: '/api/artifact?path=foo',
            filePath: 'foo',
            title: 'Foo',
          },
        ],
      });

      useArtifactStore.getState().closeTab('tab-1');

      expect(useArtifactStore.getState().kanbanOpen).toBe(true);
    });
  });

  describe('toggleKanbanTab', () => {
    it('opens kanban when it is closed', () => {
      useArtifactStore.getState().toggleKanbanTab();

      expect(useArtifactStore.getState().kanbanOpen).toBe(true);
    });

    it('closes kanban when it is open', () => {
      useArtifactStore.getState().openKanbanTab();
      useArtifactStore.getState().toggleKanbanTab();

      expect(useArtifactStore.getState().kanbanOpen).toBe(false);
    });
  });
});
