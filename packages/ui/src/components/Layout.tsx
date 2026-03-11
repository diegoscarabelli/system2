/**
 * Layout Component
 *
 * Resizable two-panel layout with main content and chat sidebar.
 */

import { ListUnorderedIcon, MoonIcon, SunIcon } from '@primer/octicons-react';
import { Box, IconButton } from '@primer/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArtifactStore } from '../stores/artifact';
import { useThemeStore } from '../stores/theme';
import { ArtifactCatalog } from './ArtifactCatalog';
import { ArtifactViewer } from './ArtifactViewer';
import { Chat } from './Chat';

export function Layout() {
  const [chatWidth, setChatWidth] = useState(33); // percentage
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { colorMode, toggleColorMode } = useThemeStore();
  const catalogOpen = useArtifactStore((s) => s.catalogOpen);
  const toggleCatalog = useArtifactStore((s) => s.toggleCatalog);

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newWidth = ((containerRect.right - e.clientX) / containerRect.width) * 100;

    // Clamp between 20% and 60%
    setChatWidth(Math.max(20, Math.min(60, newWidth)));
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
      }}
    >
      {/* Top bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 2,
          paddingX: 3,
          borderBottom: '1px solid',
          borderColor: 'border.default',
          backgroundColor: 'canvas.subtle',
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <Box
          as="h1"
          sx={{
            fontSize: 2,
            fontWeight: 'bold',
            fontFamily: 'mono',
            margin: 0,
            letterSpacing: '-0.5px',
          }}
        >
          System2
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {/* Catalog toggle */}
          <IconButton
            aria-label="Toggle artifact catalog"
            icon={ListUnorderedIcon}
            variant="invisible"
            onClick={toggleCatalog}
            sx={{ color: catalogOpen ? 'accent.fg' : 'fg.muted' }}
          />

          {/* Theme toggle */}
          <IconButton
            aria-label={colorMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            icon={colorMode === 'dark' ? SunIcon : MoonIcon}
            variant="invisible"
            onClick={toggleColorMode}
            sx={{ color: 'fg.muted' }}
          />
        </Box>
      </Box>

      {/* Main area with resizable panels */}
      <Box
        ref={containerRef}
        sx={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        }}
      >
        {/* Main content area */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'canvas.default',
            overflow: 'auto',
            position: 'relative',
          }}
        >
          <ArtifactViewer />
          {catalogOpen && <ArtifactCatalog />}
        </Box>

        {/* Resize handle */}
        <Box
          onMouseDown={handleMouseDown}
          sx={{
            width: '4px',
            cursor: 'col-resize',
            backgroundColor: 'border.default',
            '&:hover': {
              backgroundColor: 'accent.emphasis',
            },
            flexShrink: 0,
          }}
        />

        {/* Chat panel */}
        <Box
          sx={{
            width: `${chatWidth}%`,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderLeft: '1px solid',
            borderColor: 'border.default',
            backgroundColor: 'canvas.subtle',
          }}
        >
          <Chat />
        </Box>
      </Box>
    </Box>
  );
}
