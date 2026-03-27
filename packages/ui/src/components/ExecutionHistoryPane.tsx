/**
 * Execution History Pane
 *
 * Toggleable panel showing scheduler job execution history.
 * Groups executions by job name with collapsible sections.
 */

import { ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { Box, Text } from '@primer/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_ERROR_BACKOFF_MS, POLL_INTERVAL_MS } from '../constants';
import { colors } from '../theme/colors';

interface JobExecutionInfo {
  id: number;
  job_name: string;
  status: 'running' | 'completed' | 'failed';
  trigger_type: 'cron' | 'catch-up' | 'manual';
  error: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

const statusColor: Record<JobExecutionInfo['status'], string> = {
  completed: colors.teal,
  failed: colors.coral,
  running: colors.amber,
};

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

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const COLS = ['Status', 'Trigger', 'Started', 'Duration'] as const;

function TableHeaders() {
  return (
    <Box as="tr">
      {COLS.map((col) => (
        <Box
          key={col}
          as="th"
          sx={{
            px: 2,
            py: 1,
            textAlign: col === 'Status' ? 'center' : 'left',
            fontWeight: 'bold',
            color: 'fg.muted',
            borderBottom: '1px solid',
            borderColor: 'border.default',
            whiteSpace: 'nowrap',
          }}
        >
          {col}
        </Box>
      ))}
    </Box>
  );
}

export function ExecutionHistoryPane() {
  const [executions, setExecutions] = useState<JobExecutionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const fetchData = () => {
      if (!initialized.current) setLoading(true);

      fetch('/api/job-executions?limit=50', { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          setExecutions(data.executions || []);
          initialized.current = true;
          setLoading(false);
          timeoutId = setTimeout(fetchData, POLL_INTERVAL_MS);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== 'AbortError') {
            setLoading(false);
            timeoutId = setTimeout(fetchData, POLL_ERROR_BACKOFF_MS);
          }
        });
    };

    fetchData();
    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, []);

  const toggleGroupCollapse = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const toggleError = useCallback((id: number) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const grouped = useMemo(() => {
    const groups = new Map<string, JobExecutionInfo[]>();
    for (const exec of executions) {
      const list = groups.get(exec.job_name) || [];
      list.push(exec);
      groups.set(exec.job_name, list);
    }
    return groups;
  }, [executions]);

  return (
    <Box
      sx={{
        backgroundColor: 'canvas.default',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          padding: 2,
          borderBottom: '1px solid',
          borderColor: 'border.default',
          flexShrink: 0,
        }}
      >
        <Box as="h2" sx={{ fontSize: 2, fontWeight: 'bold', margin: 0 }}>
          Job Executions
        </Box>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {loading && (
          <Text sx={{ color: 'fg.muted', fontSize: 0, p: 2, display: 'block' }}>Loading...</Text>
        )}

        {!loading && executions.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 0, p: 2, display: 'block' }}>
            No executions recorded.
          </Text>
        )}

        {!loading &&
          executions.length > 0 &&
          [...grouped.entries()].map(([group, items]) => {
            const isCollapsed = collapsedGroups.has(group);
            return (
              <Box
                key={group}
                as="table"
                sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 0, mb: 3 }}
              >
                <Box as="thead">
                  <Box as="tr">
                    <Box
                      as="td"
                      colSpan={4}
                      sx={{
                        borderBottom: '1px solid',
                        borderColor: 'border.muted',
                        padding: 0,
                      }}
                    >
                      <Box
                        as="button"
                        type="button"
                        onClick={() => toggleGroupCollapse(group)}
                        aria-expanded={!isCollapsed}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          width: '100%',
                          px: 2,
                          py: 1,
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'fg.muted',
                          '&:hover': { color: 'fg.default' },
                        }}
                      >
                        {isCollapsed ? (
                          <ChevronRightIcon size={12} />
                        ) : (
                          <ChevronDownIcon size={12} />
                        )}
                        <Text sx={{ fontWeight: 'bold' }}>{group}</Text>
                        <Text sx={{ ml: 'auto' }}>{items.length}</Text>
                      </Box>
                    </Box>
                  </Box>
                  {!isCollapsed && <TableHeaders />}
                </Box>
                {!isCollapsed && (
                  <Box as="tbody">
                    {items.map((exec) => (
                      <Fragment key={exec.id}>
                        <Box
                          as="tr"
                          onClick={exec.error ? () => toggleError(exec.id) : undefined}
                          sx={{
                            cursor: exec.error ? 'pointer' : 'default',
                            '&:hover': exec.error
                              ? { backgroundColor: 'canvas.subtle' }
                              : undefined,
                          }}
                        >
                          <Box
                            as="td"
                            sx={{
                              px: 2,
                              py: 1,
                              textAlign: 'center',
                              borderBottom: '1px solid',
                              borderColor: 'border.muted',
                            }}
                          >
                            <Box
                              sx={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                backgroundColor: statusColor[exec.status],
                                display: 'inline-block',
                              }}
                            />
                          </Box>
                          <Box
                            as="td"
                            sx={{
                              px: 2,
                              py: 1,
                              borderBottom: '1px solid',
                              borderColor: 'border.muted',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {exec.trigger_type}
                          </Box>
                          <Box
                            as="td"
                            sx={{
                              px: 2,
                              py: 1,
                              borderBottom: '1px solid',
                              borderColor: 'border.muted',
                              whiteSpace: 'nowrap',
                              width: '100%',
                            }}
                          >
                            {formatTime(exec.started_at)}
                          </Box>
                          <Box
                            as="td"
                            sx={{
                              px: 2,
                              py: 1,
                              borderBottom: '1px solid',
                              borderColor: 'border.muted',
                              whiteSpace: 'nowrap',
                              fontFamily: 'mono',
                            }}
                          >
                            {formatDuration(exec.started_at, exec.ended_at)}
                          </Box>
                        </Box>
                        {exec.error && expandedErrors.has(exec.id) && (
                          <Box as="tr">
                            <Box
                              as="td"
                              colSpan={4}
                              sx={{
                                px: 2,
                                py: 1,
                                borderBottom: '1px solid',
                                borderColor: 'border.muted',
                                color: colors.coral,
                                fontSize: 0,
                                fontFamily: 'mono',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}
                            >
                              {exec.error}
                            </Box>
                          </Box>
                        )}
                      </Fragment>
                    ))}
                  </Box>
                )}
              </Box>
            );
          })}
      </Box>
    </Box>
  );
}
