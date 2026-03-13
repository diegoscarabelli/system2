/**
 * ProjectDetailModal Component
 *
 * Overlay modal showing full project details.
 * Opened from the KanbanBoard when the info icon on a swimlane header is clicked.
 */

import { XIcon } from '@primer/octicons-react';
import { Box, IconButton, Text } from '@primer/react';
import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import { colors } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';

interface ProjectData {
  id: number;
  name: string;
  description: string;
  status: string;
  labels: string;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  updated_at: string;
}

function statusColor(status: string, accent: string, highlight: string): string {
  if (status === 'todo') return colors.gray;
  if (status === 'in progress') return accent;
  if (status === 'review') return highlight;
  if (status === 'done') return colors.teal;
  if (status === 'abandoned') return colors.teal;
  return colors.gray;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(`${iso}Z`).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function StatusBadge({
  status,
  accent,
  highlight,
}: {
  status: string;
  accent: string;
  highlight: string;
}) {
  const bg = statusColor(status, accent, highlight);
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: '8px',
        py: '2px',
        borderRadius: 10,
        backgroundColor: `${bg}22`,
        border: `1px solid ${bg}44`,
        fontSize: '11px',
        color: bg,
        fontWeight: 'semibold',
        lineHeight: 1.6,
      }}
    >
      {status}
    </Box>
  );
}

export function ProjectDetailModal({
  project,
  onClose,
}: {
  project: ProjectData;
  onClose: () => void;
}) {
  const { accent, highlight } = useAccentColors();
  const panelRef = useRef<HTMLDivElement>(null);

  const labels: string[] = (() => {
    if (!project.labels) return [];
    if (typeof project.labels !== 'string') return project.labels as unknown as string[];
    try {
      return JSON.parse(project.labels) as string[];
    } catch {
      return [];
    }
  })();

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <Box
      onClick={handleBackdropClick}
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 3,
      }}
    >
      <Box
        ref={panelRef}
        sx={{
          width: '100%',
          maxWidth: 700,
          maxHeight: '85vh',
          overflow: 'auto',
          backgroundColor: 'canvas.default',
          border: '1px solid',
          borderColor: 'border.default',
          borderRadius: 2,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 2,
            px: 4,
            pt: 4,
            pb: 3,
            borderBottom: '1px solid',
            borderColor: 'border.muted',
            flexShrink: 0,
          }}
        >
          <Box sx={{ flex: 1 }}>
            <Text sx={{ fontWeight: 'bold', fontSize: 3, color: 'fg.default', lineHeight: 1.3 }}>
              <Text as="span" sx={{ color: 'fg.muted' }}>
                #{project.id}
              </Text>{' '}
              {project.name}
            </Text>
          </Box>
          <IconButton
            aria-label="Close"
            icon={XIcon}
            variant="invisible"
            size="small"
            onClick={onClose}
            sx={{ color: 'fg.muted', flexShrink: 0 }}
          />
        </Box>

        <Box sx={{ px: 4, py: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Fields */}
          <Box
            as="dl"
            sx={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 3,
              rowGap: 2,
              m: 0,
              fontSize: 0,
              '& dt': {
                fontSize: '10px',
                color: 'fg.muted',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                lineHeight: '20px',
              },
              '& dd': { m: 0, lineHeight: '20px', color: 'fg.default' },
            }}
          >
            <dt>Status:</dt>
            <dd>
              <StatusBadge status={project.status} accent={accent} highlight={highlight} />
            </dd>
            <dt>Labels:</dt>
            <dd>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {labels.length > 0 ? (
                  labels.map((label) => (
                    <Box
                      key={label}
                      sx={{
                        px: '8px',
                        py: '2px',
                        borderRadius: 10,
                        backgroundColor: `${accent}22`,
                        border: `1px solid ${accent}44`,
                        fontSize: '11px',
                        color: accent,
                        lineHeight: 1.6,
                      }}
                    >
                      {label}
                    </Box>
                  ))
                ) : (
                  <Text sx={{ color: 'fg.muted', fontSize: '11px' }}>&mdash;</Text>
                )}
              </Box>
            </dd>
            <dt>Started:</dt>
            <dd>
              {project.start_at ? (
                formatDate(project.start_at)
              ) : (
                <Text sx={{ color: 'fg.muted', fontSize: '11px' }}>&mdash;</Text>
              )}
            </dd>
            <dt>Completed:</dt>
            <dd>
              {project.end_at ? (
                formatDate(project.end_at)
              ) : (
                <Text sx={{ color: 'fg.muted', fontSize: '11px' }}>&mdash;</Text>
              )}
            </dd>
            <dt>Created:</dt>
            <dd>{formatDate(project.created_at)}</dd>
            <dt>Updated:</dt>
            <dd>{formatDate(project.updated_at)}</dd>
          </Box>

          {/* Description */}
          {project.description && (
            <Box>
              <Text
                sx={{
                  fontSize: '10px',
                  color: 'fg.muted',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  mb: 2,
                  display: 'block',
                }}
              >
                Description:
              </Text>
              <Box
                sx={{
                  fontSize: 0,
                  color: 'fg.default',
                  lineHeight: 1.6,
                  '& p': { m: 0, mb: 2 },
                  '& p:last-child': { mb: 0 },
                  '& code': {
                    fontFamily: 'mono',
                    fontSize: '11px',
                    px: '4px',
                    py: '1px',
                    borderRadius: 2,
                    backgroundColor: 'canvas.subtle',
                  },
                  '& pre': {
                    p: 2,
                    borderRadius: 1,
                    backgroundColor: 'canvas.subtle',
                    overflow: 'auto',
                  },
                }}
              >
                <Markdown>{project.description}</Markdown>
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
