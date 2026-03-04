/**
 * Artifact Viewer Component
 *
 * Displays HTML artifacts in a sandboxed iframe.
 * Includes a postMessage bridge for interactive dashboard queries.
 */

import { Box, Text } from '@primer/react';
import { useEffect, useRef } from 'react';
import { useArtifactStore } from '../stores/artifact';
import { useThemeStore } from '../stores/theme';

export function ArtifactViewer() {
  const currentUrl = useArtifactStore((s) => s.currentUrl);
  const colorMode = useThemeStore((s) => s.colorMode);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isLight = colorMode === 'light';

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

  if (!currentUrl) {
    return (
      <Box
        sx={{
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'fg.muted',
        }}
      >
        <Text sx={{ fontSize: 1 }}>Chat with the Guide on the right</Text>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        <iframe
          ref={iframeRef}
          src={currentUrl}
          sandbox="allow-scripts allow-same-origin"
          title="Artifact"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            backgroundColor: isLight ? 'white' : 'transparent',
            filter: isLight ? 'invert(1) hue-rotate(180deg)' : 'none',
          }}
        />
      </Box>
    </Box>
  );
}
