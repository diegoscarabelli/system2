/**
 * Artifact Viewer Component
 *
 * Displays artifacts in a tabbed panel with sandboxed iframes.
 * Includes a postMessage bridge for interactive dashboard queries.
 */

import { XIcon } from '@primer/octicons-react';
import { Box, IconButton, Text } from '@primer/react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { useArtifactMtimePoll } from '../hooks/useArtifactMtimePoll';
import { handleQueryMessage } from '../query-bridge';
import { useArtifactStore } from '../stores/artifact';
import { useThemeStore } from '../stores/theme';
import { useAccentColors } from '../theme/useAccentColors';
import { KanbanBoard } from './KanbanBoard';
import { ParticlesBackground } from './ParticlesBackground';

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024; // 5 MB

function useFetchText(url: string) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(null);
    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
        const length = res.headers.get('content-length');
        if (length && Number(length) > MAX_PREVIEW_BYTES) {
          throw new Error('File too large to preview');
        }
        return res.text();
      })
      .then((text) => {
        if (text.length > MAX_PREVIEW_BYTES) {
          setContent(`${text.slice(0, MAX_PREVIEW_BYTES)}\n\n… (truncated, file exceeds 5 MB)`);
        } else {
          setContent(text);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, [url]);

  return { content, error };
}

function CodeArtifact({ url }: { url: string }) {
  const { content, error } = useFetchText(url);

  if (error) {
    return (
      <Box sx={{ p: 4, color: 'danger.fg' }}>
        <Text>{error}</Text>
      </Box>
    );
  }

  if (content === null) {
    return (
      <Box sx={{ p: 4, color: 'fg.muted' }}>
        <Text>Loading…</Text>
      </Box>
    );
  }

  return (
    <Box
      as="pre"
      sx={{
        m: 0,
        p: 3,
        fontFamily: 'mono',
        fontSize: 0,
        lineHeight: 1.5,
        color: 'fg.default',
        backgroundColor: 'neutral.muted',
        borderRadius: 2,
        overflow: 'auto',
        whiteSpace: 'pre',
      }}
    >
      {content}
    </Box>
  );
}

function MarkdownArtifact({ url }: { url: string }) {
  const { content, error } = useFetchText(url);

  if (error) {
    return (
      <Box sx={{ p: 4, color: 'danger.fg' }}>
        <Text>{error}</Text>
      </Box>
    );
  }

  if (content === null) {
    return (
      <Box sx={{ p: 4, color: 'fg.muted' }}>
        <Text>Loading…</Text>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        p: 4,
        fontSize: 1,
        color: 'fg.default',
        '& p': { margin: 0, marginBottom: 2 },
        '& p:last-child': { marginBottom: 0 },
        '& h1, & h2, & h3, & h4, & h5, & h6': {
          marginTop: 3,
          marginBottom: 2,
          fontWeight: 'bold',
        },
        '& h1': { fontSize: 4 },
        '& h2': { fontSize: 3 },
        '& h3': { fontSize: 2 },
        '& ul, & ol': { marginTop: 1, marginBottom: 2, paddingLeft: 3 },
        '& li': { marginBottom: 1 },
        '& code': {
          fontFamily: 'mono',
          backgroundColor: 'neutral.muted',
          padding: '2px 4px',
          borderRadius: 1,
          fontSize: 0,
        },
        '& pre': {
          backgroundColor: 'neutral.muted',
          padding: 2,
          borderRadius: 2,
          overflow: 'auto',
          marginTop: 2,
          marginBottom: 2,
        },
        '& pre code': { backgroundColor: 'transparent', padding: 0 },
        '& strong': { fontWeight: 'bold' },
        '& em': { fontStyle: 'italic' },
        '& hr': {
          border: 'none',
          borderTop: '1px solid',
          borderColor: 'border.muted',
          marginTop: 3,
          marginBottom: 3,
        },
        '& a': { color: 'accent.fg' },
        '& blockquote': {
          borderLeft: '3px solid',
          borderColor: 'border.default',
          paddingLeft: 2,
          marginLeft: 0,
          color: 'fg.muted',
        },
        '& table': {
          borderCollapse: 'collapse',
          width: '100%',
          marginTop: 2,
          marginBottom: 2,
        },
        '& th, & td': {
          border: '1px solid',
          borderColor: 'border.default',
          padding: 2,
          textAlign: 'left',
        },
        '& th': { fontWeight: 'bold', backgroundColor: 'neutral.muted' },
        '& img': { maxWidth: '100%' },
      }}
    >
      <Markdown>{content}</Markdown>
    </Box>
  );
}

export function ArtifactViewer() {
  const tabs = useArtifactStore((s) => s.tabs);
  const activeTabId = useArtifactStore((s) => s.activeTabId);
  const closeTab = useArtifactStore((s) => s.closeTab);
  const setActiveTab = useArtifactStore((s) => s.setActiveTab);
  const colorMode = useThemeStore((s) => s.colorMode);
  const particlesEnabled = useThemeStore((s) => s.particlesEnabled);
  const { accent } = useAccentColors();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isLight = colorMode === 'light';

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Poll for file changes on the active artifact tab
  useArtifactMtimePoll(activeTab?.type === 'iframe' ? activeTab.filePath : null);

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
      handleQueryMessage(event.data, (msg, origin) =>
        iframeRef.current?.contentWindow?.postMessage(msg, origin)
      );
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
      {particlesEnabled && <ParticlesBackground />}

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
              backgroundColor: 'transparent',
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
                  borderBottom:
                    tab.id === activeTabId ? `2px solid ${accent}` : '2px solid transparent',
                  borderRight: '1px solid',
                  borderColor: 'border.muted',
                  borderBottomColor: tab.id === activeTabId ? accent : 'transparent',
                  backgroundColor: tab.id === activeTabId ? 'canvas.default' : 'transparent',
                  color: tab.id === activeTabId ? 'fg.default' : 'fg.muted',
                  fontSize: 0,
                  whiteSpace: 'nowrap',
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
              {activeTab.type === 'native' && activeTab.component === 'kanban' ? (
                <KanbanBoard />
              ) : /\.(?:md|markdown)$/i.test(activeTab.filePath) ? (
                <MarkdownArtifact url={activeTab.url} />
              ) : /\.(?:toml|ya?ml|jsonl?|xml|csv|txt|log|sql|py|sh|css|ts|tsx|js|jsx)$/i.test(
                  activeTab.filePath
                ) ? (
                <CodeArtifact url={activeTab.url} />
              ) : /\.html?$/i.test(activeTab.filePath) ? (
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
              ) : /\.pdf$/i.test(activeTab.filePath) ? (
                <iframe
                  src={activeTab.url}
                  sandbox="allow-same-origin"
                  title={activeTab.title}
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                  }}
                />
              ) : /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i.test(activeTab.filePath) ? (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    p: 3,
                  }}
                >
                  <img
                    src={activeTab.url}
                    alt={activeTab.title}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
                </Box>
              ) : (
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    gap: 2,
                    color: 'fg.muted',
                    textAlign: 'center',
                    px: 4,
                  }}
                >
                  <Text sx={{ fontSize: 2 }}>Cannot preview this file type</Text>
                  <Text sx={{ fontSize: 0, fontFamily: 'mono', wordBreak: 'break-all' }}>
                    {activeTab.filePath}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
