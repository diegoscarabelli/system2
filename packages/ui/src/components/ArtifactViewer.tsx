/**
 * Artifact Viewer Component
 *
 * Displays artifacts in a tabbed panel with sandboxed iframes.
 * Includes a postMessage bridge for interactive dashboard queries.
 */

import { XIcon } from '@primer/octicons-react';
import { Box, IconButton, Text } from '@primer/react';
import { useEffect, useRef } from 'react';
import { useArtifactStore } from '../stores/artifact';
import { useThemeStore } from '../stores/theme';
import { useAccentColors } from '../theme/useAccentColors';
import { ParticlesBackground } from './ParticlesBackground';

export function ArtifactViewer() {
  const tabs = useArtifactStore((s) => s.tabs);
  const activeTabId = useArtifactStore((s) => s.activeTabId);
  const closeTab = useArtifactStore((s) => s.closeTab);
  const setActiveTab = useArtifactStore((s) => s.setActiveTab);
  const colorMode = useThemeStore((s) => s.colorMode);
  const { accent } = useAccentColors();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isLight = colorMode === 'light';

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Resize iframe to its content height so the parent container handles scrolling.
  // Uses ResizeObserver on the iframe body to track dynamic content changes
  // (e.g. database viewer rendering query results after initial load).
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeTab?.url triggers resize when artifact changes
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let observer: ResizeObserver | null = null;

    function resizeToContent() {
      try {
        if (!iframe) return;
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        iframe.style.height = `${doc.documentElement.scrollHeight}px`;
      } catch {
        // Cross-origin — ignore
      }
    }

    function setup() {
      try {
        if (!iframe) return;
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        resizeToContent();
        observer = new ResizeObserver(resizeToContent);
        observer.observe(doc.body);
      } catch {
        // Cross-origin — ignore
      }
    }

    iframe.addEventListener('load', setup);
    setup();

    return () => {
      iframe.removeEventListener('load', setup);
      observer?.disconnect();
    };
  }, [activeTab?.url]);

  // postMessage bridge: listen for query requests from iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;

      const { type, requestId, sql } = event.data || {};
      if (type === 'system2:query') {
        fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql }),
        })
          .then((res) => res.json())
          .then((data) => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'system2:query_result', requestId, data },
              '*'
            );
          })
          .catch((err) => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'system2:query_error', requestId, error: err.message },
              '*'
            );
          });
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <ParticlesBackground />

      {tabs.length === 0 ? (
        <Box sx={{ height: '100%', position: 'relative', zIndex: 1 }} />
      ) : (
        <>
          {/* Tab bar */}
          <Box
            sx={{
              display: 'flex',
              overflowX: 'auto',
              borderBottom: '1px solid',
              borderColor: 'border.default',
              backgroundColor: 'canvas.subtle',
              flexShrink: 0,
              position: 'relative',
              zIndex: 1,
            }}
          >
            {tabs.map((tab) => (
              <Box
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 2,
                  py: 1,
                  cursor: 'pointer',
                  borderBottom: tab.id === activeTabId ? '2px solid' : '2px solid transparent',
                  borderColor: tab.id === activeTabId ? accent : 'transparent',
                  backgroundColor: tab.id === activeTabId ? 'canvas.default' : 'transparent',
                  color: tab.id === activeTabId ? 'fg.default' : 'fg.muted',
                  fontSize: 0,
                  whiteSpace: 'nowrap',
                  '&:hover': {
                    backgroundColor: 'canvas.default',
                  },
                }}
              >
                <Text sx={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {tab.title}
                </Text>
                <IconButton
                  aria-label="Close tab"
                  icon={XIcon}
                  variant="invisible"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  sx={{ color: 'fg.muted', flexShrink: 0 }}
                />
              </Box>
            ))}
          </Box>

          {/* Active tab content */}
          {activeTab && (
            <Box sx={{ flex: 1, overflow: 'auto', position: 'relative', zIndex: 1 }}>
              <iframe
                ref={iframeRef}
                src={activeTab.url}
                sandbox="allow-scripts allow-same-origin"
                title={activeTab.title}
                scrolling="no"
                style={{
                  width: '100%',
                  border: 'none',
                  overflow: 'hidden',
                  backgroundColor: isLight ? 'white' : 'transparent',
                  filter: isLight ? 'none' : 'invert(1) hue-rotate(180deg)',
                }}
              />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
