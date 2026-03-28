/**
 * JobExecutionDetailModal Component
 *
 * Overlay modal showing full job execution details.
 * Opened from the CronJobsPane when a row is clicked.
 */

import { XIcon } from '@primer/octicons-react';
import { Box, IconButton, Text } from '@primer/react';
import { useEffect, useRef } from 'react';
import { colors } from '../theme/colors';
import type { JobExecutionInfo } from './CronJobsPane';

const statusColor: Record<JobExecutionInfo['status'], string> = {
  completed: colors.teal,
  failed: colors.coral,
  running: colors.amber,
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return '—';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function StatusBadge({ status }: { status: JobExecutionInfo['status'] }) {
  const bg = statusColor[status];
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

export function JobExecutionDetailModal({
  execution,
  onClose,
}: {
  execution: JobExecutionInfo;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

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
      role="dialog"
      aria-modal="true"
      aria-labelledby="execution-detail-title"
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
            <Text
              id="execution-detail-title"
              sx={{ fontWeight: 'bold', fontSize: 3, color: 'fg.default', lineHeight: 1.3 }}
            >
              <Text as="span" sx={{ color: 'fg.muted' }}>
                #{execution.id}
              </Text>{' '}
              {execution.job_name}
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
              <StatusBadge status={execution.status} />
            </dd>
            <dt>Trigger:</dt>
            <dd>{execution.trigger_type}</dd>
            <dt>Started:</dt>
            <dd>{formatDate(execution.started_at)}</dd>
            <dt>Ended:</dt>
            <dd>
              {execution.ended_at ? (
                formatDate(execution.ended_at)
              ) : (
                <Text sx={{ color: 'fg.muted', fontSize: '11px' }}>&mdash;</Text>
              )}
            </dd>
            <dt>Duration:</dt>
            <dd>
              <Text sx={{ fontFamily: 'mono' }}>
                {formatDuration(execution.started_at, execution.ended_at)}
              </Text>
            </dd>
            <dt>Created:</dt>
            <dd>{formatDate(execution.created_at)}</dd>
            <dt>Updated:</dt>
            <dd>{formatDate(execution.updated_at)}</dd>
          </Box>

          {/* Error */}
          {execution.error && (
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
                Error:
              </Text>
              <Box
                sx={{
                  fontSize: 0,
                  color: colors.coral,
                  fontFamily: 'mono',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  p: 2,
                  borderRadius: 1,
                  backgroundColor: 'canvas.subtle',
                }}
              >
                {execution.error}
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
