/**
 * Layout Component
 *
 * VSCode-style layout: activity bar, optional drawer, artifact viewer, and chat.
 */

import { MoonIcon, PeopleIcon, StackIcon, SunIcon, ZapIcon } from '@primer/octicons-react';
import { Box, IconButton } from '@primer/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArtifactStore } from '../stores/artifact';
import { useThemeStore } from '../stores/theme';
import { useAccentColors } from '../theme/useAccentColors';
import { AgentPane } from './AgentPane';
import { ArtifactCatalog } from './ArtifactCatalog';
import { ArtifactViewer } from './ArtifactViewer';
import { Chat } from './Chat';

const ACTIVITY_BAR_PX = 48;

export function Layout() {
  const [chatWidth, setChatWidth] = useState(33); // percentage of container
  const [catalogWidth, setCatalogWidth] = useState(20); // percentage of container
  const [isDraggingAny, setIsDraggingAny] = useState(false);
  const isDragging = useRef(false);
  const isCatalogDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { colorMode, toggleColorMode, particlesEnabled, toggleParticles } = useThemeStore();
  const { accent } = useAccentColors();
  const catalogOpen = useArtifactStore((s) => s.catalogOpen);
  const agentsOpen = useArtifactStore((s) => s.agentsOpen);
  const toggleCatalog = useArtifactStore((s) => s.toggleCatalog);
  const toggleAgents = useArtifactStore((s) => s.toggleAgents);
  const sideDrawerOpen = catalogOpen || agentsOpen;

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    setIsDraggingAny(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleCatalogMouseDown = useCallback(() => {
    isCatalogDragging.current = true;
    setIsDraggingAny(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    isCatalogDragging.current = false;
    setIsDraggingAny(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    if (isDragging.current) {
      const newWidth = ((containerRect.right - e.clientX) / containerRect.width) * 100;
      setChatWidth(Math.max(20, Math.min(60, newWidth)));
    } else if (isCatalogDragging.current) {
      const newWidth =
        ((e.clientX - containerRect.left - ACTIVITY_BAR_PX) / containerRect.width) * 100;
      setCatalogWidth(Math.max(10, Math.min(40, newWidth)));
    }
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
      ref={containerRef}
      sx={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
      }}
    >
      {/* Drag overlay — prevents iframes from capturing mouse events during resize */}
      {isDraggingAny && (
        <Box sx={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: 'col-resize' }} />
      )}

      {/* Activity bar */}
      <Box
        sx={{
          width: `${ACTIVITY_BAR_PX}px`,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          alignItems: 'center',
          py: 2,
          backgroundColor: 'canvas.subtle',
          borderRight: '1px solid',
          borderColor: 'border.default',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <IconButton
            aria-label="Artifact catalog"
            icon={StackIcon}
            variant="invisible"
            size="medium"
            onClick={toggleCatalog}
            sx={{
              color: catalogOpen ? 'fg.default' : 'fg.muted',
              position: 'relative',
              '&::before': catalogOpen
                ? {
                    content: '""',
                    position: 'absolute',
                    left: '-8px',
                    top: '25%',
                    bottom: '25%',
                    width: '2px',
                    backgroundColor: accent,
                    borderRadius: 1,
                  }
                : {},
            }}
          />
          <IconButton
            aria-label="Active agents"
            icon={PeopleIcon}
            variant="invisible"
            size="medium"
            onClick={toggleAgents}
            sx={{
              color: agentsOpen ? 'fg.default' : 'fg.muted',
              position: 'relative',
              '&::before': agentsOpen
                ? {
                    content: '""',
                    position: 'absolute',
                    left: '-8px',
                    top: '25%',
                    bottom: '25%',
                    width: '2px',
                    backgroundColor: accent,
                    borderRadius: 1,
                  }
                : {},
            }}
          />
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <IconButton
            aria-label={particlesEnabled ? 'Disable particles' : 'Enable particles'}
            icon={ZapIcon}
            variant="invisible"
            size="medium"
            onClick={toggleParticles}
            sx={{ color: particlesEnabled ? accent : 'fg.muted' }}
          />
          <IconButton
            aria-label={colorMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            icon={colorMode === 'dark' ? SunIcon : MoonIcon}
            variant="invisible"
            size="medium"
            onClick={toggleColorMode}
            sx={{ color: 'fg.muted' }}
          />
        </Box>
      </Box>

      {/* Side drawer (catalog or agents) */}
      {sideDrawerOpen && (
        <Box
          sx={{
            width: `${catalogWidth}%`,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {catalogOpen && <ArtifactCatalog />}
          {agentsOpen && <AgentPane />}
        </Box>
      )}

      {/* Side drawer resize handle */}
      {sideDrawerOpen && (
        <Box
          onMouseDown={handleCatalogMouseDown}
          sx={{
            width: '2px',
            cursor: 'col-resize',
            backgroundColor: 'border.default',
            '&:hover': { backgroundColor: accent },
            flexShrink: 0,
          }}
        />
      )}

      {/* Artifact viewer */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'canvas.default',
          overflow: 'auto',
        }}
      >
        <ArtifactViewer />
      </Box>

      {/* Chat resize handle */}
      <Box
        onMouseDown={handleMouseDown}
        sx={{
          width: '2px',
          cursor: 'col-resize',
          backgroundColor: 'border.default',
          '&:hover': { backgroundColor: accent },
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
          backgroundColor: 'canvas.subtle',
        }}
      >
        <Chat />
      </Box>
    </Box>
  );
}
