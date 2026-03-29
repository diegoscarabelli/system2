/**
 * Cron Jobs Pane
 *
 * Toggleable panel showing scheduler job execution history.
 * Flat sortable table with multiselect filters for job, status, and trigger.
 */

import { TriangleDownIcon, TriangleUpIcon } from '@primer/octicons-react';
import { Box, Text } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { POLL_ERROR_BACKOFF_MS, POLL_INTERVAL_MS } from '../constants';
import { colors } from '../theme/colors';
import { JobExecutionDetailModal } from './JobExecutionDetailModal';
import type { MultiSelectOption } from './MultiSelectDropdown';
import { MultiSelectDropdown } from './MultiSelectDropdown';

export interface JobExecutionInfo {
  id: number;
  job_name: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
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
  skipped: colors.gray,
};

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

type SortKey = 'id' | 'job_name' | 'status' | 'trigger_type' | 'started_at' | 'ended_at';
type SortDir = 'asc' | 'desc';

function compareValues(
  a: JobExecutionInfo,
  b: JobExecutionInfo,
  key: SortKey,
  dir: SortDir
): number {
  let cmp = 0;
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) cmp = 0;
  else if (av == null) cmp = 1;
  else if (bv == null) cmp = -1;
  else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv));
  return dir === 'asc' ? cmp : -cmp;
}

const COLS: { label: string; key: SortKey }[] = [
  { label: 'ID', key: 'id' },
  { label: 'Job', key: 'job_name' },
  { label: 'Status', key: 'status' },
  { label: 'Trigger', key: 'trigger_type' },
  { label: 'Started', key: 'started_at' },
  { label: 'Ended', key: 'ended_at' },
];

const STATUS_OPTIONS: MultiSelectOption[] = [
  { value: 'completed', label: 'completed' },
  { value: 'failed', label: 'failed' },
  { value: 'running', label: 'running' },
  { value: 'skipped', label: 'skipped' },
];

const TRIGGER_OPTIONS: MultiSelectOption[] = [
  { value: 'cron', label: 'cron' },
  { value: 'catch-up', label: 'catch-up' },
  { value: 'manual', label: 'manual' },
];

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  const icon =
    active && dir === 'asc' ? <TriangleUpIcon size={12} /> : <TriangleDownIcon size={12} />;
  return (
    <Box as="span" sx={{ opacity: active ? 1 : 0.3 }}>
      {icon}
    </Box>
  );
}

interface TableHeadersProps {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}

function TableHeaders({ sortKey, sortDir, onSort }: TableHeadersProps) {
  return (
    <Box as="tr">
      {COLS.map((col) => (
        <Box
          key={col.key}
          as="th"
          onClick={() => onSort(col.key)}
          sx={{
            px: 2,
            py: 1,
            textAlign: 'left',
            fontWeight: 'bold',
            color: 'fg.muted',
            borderBottom: '1px solid',
            borderColor: 'border.default',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            userSelect: 'none',
            '&:hover': { color: 'fg.default' },
          }}
        >
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
            {col.label}
            <SortIndicator active={sortKey === col.key} dir={sortDir} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function CronJobsPane() {
  const [executions, setExecutions] = useState<JobExecutionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('started_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const initialized = useRef(false);

  // Filter state: initialized with all options on first data load
  const [statusFilter, setStatusFilter] = useState<Set<string>>(
    new Set(STATUS_OPTIONS.map((o) => o.value))
  );
  const [triggerFilter, setTriggerFilter] = useState<Set<string>>(
    new Set(TRIGGER_OPTIONS.map((o) => o.value))
  );
  const [jobFilter, setJobFilter] = useState<Set<string>>(new Set());
  const [jobOptions, setJobOptions] = useState<MultiSelectOption[]>([]);
  const jobsSeeded = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const fetchData = () => {
      if (!initialized.current) setLoading(true);

      fetch('/api/job-executions?limit=50', { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          const items: JobExecutionInfo[] = data.executions || [];
          setExecutions(items);
          initialized.current = true;
          setLoading(false);

          // Seed job options on first data load
          if (!jobsSeeded.current && items.length > 0) {
            jobsSeeded.current = true;
            const names = [...new Set(items.map((e) => e.job_name))].sort();
            const opts = names.map((n) => ({ value: n, label: n }));
            setJobOptions(opts);
            setJobFilter(new Set(names));
          }

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

  const closeModal = useCallback(() => setSelectedId(null), []);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('desc');
      }
    },
    [sortKey]
  );

  const filtered = useMemo(() => {
    return executions
      .filter(
        (e) =>
          jobFilter.has(e.job_name) &&
          statusFilter.has(e.status) &&
          triggerFilter.has(e.trigger_type)
      )
      .sort((a, b) => compareValues(a, b, sortKey, sortDir));
  }, [executions, jobFilter, statusFilter, triggerFilter, sortKey, sortDir]);

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
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Box as="h2" sx={{ fontSize: 2, fontWeight: 'bold', margin: 0 }}>
          Cron Jobs
        </Box>
        {executions.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <MultiSelectDropdown
              label="jobs"
              options={jobOptions}
              selected={jobFilter}
              onChange={setJobFilter}
            />
            <MultiSelectDropdown
              label="statuses"
              options={STATUS_OPTIONS}
              selected={statusFilter}
              onChange={setStatusFilter}
            />
            <MultiSelectDropdown
              label="triggers"
              options={TRIGGER_OPTIONS}
              selected={triggerFilter}
              onChange={setTriggerFilter}
            />
          </Box>
        )}
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

        {!loading && filtered.length > 0 && (
          <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 0 }}>
            <Box as="thead">
              <TableHeaders sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </Box>
            <Box as="tbody">
              {filtered.map((exec) => (
                <Box
                  key={exec.id}
                  as="tr"
                  tabIndex={0}
                  onClick={() => setSelectedId(exec.id)}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(exec.id);
                    }
                  }}
                  sx={{
                    cursor: 'pointer',
                    '&:hover': { backgroundColor: 'canvas.subtle' },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'accent.fg' },
                  }}
                >
                  <Box
                    as="td"
                    sx={{
                      px: 2,
                      py: 1,
                      borderBottom: '1px solid',
                      borderColor: 'border.muted',
                      whiteSpace: 'nowrap',
                      fontFamily: 'mono',
                      color: 'fg.muted',
                    }}
                  >
                    {exec.id}
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
                    {exec.job_name}
                  </Box>
                  <Box
                    as="td"
                    sx={{
                      px: 2,
                      py: 1,
                      borderBottom: '1px solid',
                      borderColor: 'border.muted',
                      whiteSpace: 'nowrap',
                      color: statusColor[exec.status],
                    }}
                  >
                    {exec.status}
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
                    }}
                  >
                    {exec.ended_at ? formatTime(exec.ended_at) : '—'}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>

      {selectedId != null &&
        (() => {
          const exec = executions.find((e) => e.id === selectedId);
          return exec ? <JobExecutionDetailModal execution={exec} onClose={closeModal} /> : null;
        })()}
    </Box>
  );
}
