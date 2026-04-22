import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useArtifactStore } from '../stores/artifact';

const ARTIFACT_PATH = '/home/user/dashboard.html';

describe('useArtifactMtimePoll (store integration)', () => {
  beforeEach(() => {
    useArtifactStore.setState({
      tabs: [
        {
          id: 'tab-1',
          type: 'iframe',
          url: `/api/artifact?path=${encodeURIComponent(ARTIFACT_PATH)}`,
          filePath: ARTIFACT_PATH,
          title: 'dashboard.html',
        },
      ],
      activeTabId: 'tab-1',
    });
  });

  afterEach(() => {
    useArtifactStore.setState({
      tabs: [],
      activeTabId: null,
      catalogOpen: false,
      agentsOpen: false,
      cronJobsOpen: false,
      kanbanOpen: false,
    });
  });

  it('reloadTab updates the URL for a matching tab', () => {
    const store = useArtifactStore.getState();
    store.reloadTab(ARTIFACT_PATH, '/api/artifact?path=%2Fhome%2Fuser%2Fdashboard.html&t=123');

    const tab = useArtifactStore.getState().tabs.find((t) => t.filePath === ARTIFACT_PATH);
    expect(tab?.url).toContain('&t=123');
  });

  it('reloadTab does not affect other tabs', () => {
    useArtifactStore.setState({
      tabs: [
        ...useArtifactStore.getState().tabs,
        {
          id: 'tab-2',
          type: 'iframe',
          url: '/api/artifact?path=%2Fother.html',
          filePath: '/other.html',
          title: 'other.html',
        },
      ],
    });

    useArtifactStore.getState().reloadTab(ARTIFACT_PATH, '/api/artifact?path=x&t=999');

    const other = useArtifactStore.getState().tabs.find((t) => t.filePath === '/other.html');
    expect(other?.url).toBe('/api/artifact?path=%2Fother.html');
  });
});
