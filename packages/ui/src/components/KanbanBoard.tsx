/**
 * KanbanBoard Component
 *
 * Live kanban dashboard showing tasks grouped by project in a swimlane layout.
 * Fetches from /api/kanban and auto-refreshes when tasksVersion increments.
 */

import { ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { Box, Text } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArtifactStore } from '../stores/artifact';
import { colors } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';
import { TaskDetailModal } from './TaskDetailModal';

const COLUMNS = ['todo', 'in progress', 'review', 'done'] as const;
type Column = (typeof COLUMNS)[number];

const STATUS_LABELS: Record<Column, string> = {
  todo: 'Todo',
  'in progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

const STATUS_COLORS: Record<Column, string> = {
  todo: colors.gray,
  'in progress': '#58a6ff',
  review: '#f0883e',
  done: '#3fb950',
};

interface KanbanTask {
  id: number;
  parent: number | null;
  project: number | null;
  title: string;
  description: string;
  status: string;
  priority: 'low' | 'medium' | 'high';
  assignee: number | null;
  labels: string[];
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  project_name: string | null;
  assignee_role: string | null;
}

interface KanbanProject {
  id: number;
  name: string;
  status: string;
}

interface KanbanAgent {
  id: number;
  role: string;
  project: number | null;
}

interface KanbanData {
  tasks: KanbanTask[];
  projects: KanbanProject[];
  agents: KanbanAgent[];
}

interface SwimlaneGroup {
  id: number | null;
  name: string;
  status: string;
  tasks: KanbanTask[];
}

function priorityColor(priority: string, accent: string): string {
  if (priority === 'high') return colors.coral;
  if (priority === 'medium') return accent;
  return colors.gray;
}

function KanbanCard({
  task,
  accent,
  onClick,
}: {
  task: KanbanTask;
  accent: string;
  onClick: () => void;
}) {
  const stripeColor = priorityColor(task.priority, accent);
  return (
    <Box
      onClick={onClick}
      sx={{
        backgroundColor: 'canvas.default',
        borderTop: '1px solid',
        borderRight: '1px solid',
        borderBottom: '1px solid',
        borderLeft: `3px solid ${stripeColor}`,
        borderColor: 'border.muted',
        borderLeftColor: stripeColor,
        borderRadius: 1,
        px: 2,
        py: 1,
        cursor: 'pointer',
        '&:hover': { backgroundColor: 'canvas.subtle' },
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        mb: 1,
      }}
    >
      <Text sx={{ fontWeight: 'bold', fontSize: 0, lineHeight: 1.3, color: 'fg.default' }}>
        {task.title}
      </Text>
      {task.labels.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
          {task.labels.map((label) => (
            <Box
              key={label}
              sx={{
                fontSize: '10px',
                px: '5px',
                py: '1px',
                borderRadius: 10,
                backgroundColor: `${accent}22`,
                color: accent,
                lineHeight: 1.5,
              }}
            >
              {label}
            </Box>
          ))}
        </Box>
      )}
      {task.assignee_role && (
        <Text sx={{ fontSize: '10px', color: 'fg.subtle', textAlign: 'right', mt: '2px' }}>
          {task.assignee_role}
        </Text>
      )}
    </Box>
  );
}

export function KanbanBoard() {
  const tasksVersion = useArtifactStore((s) => s.tasksVersion);
  const { accent } = useAccentColors();
  const [data, setData] = useState<KanbanData | null>(null);
  const [loading, setLoading] = useState(true); // true only on initial load
  const [refreshing, setRefreshing] = useState(false);
  const initialized = useRef(false);
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterAssignee, setFilterAssignee] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number | null>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const handleCloseModal = useCallback(() => setSelectedTaskId(null), []);
  const handleNavigate = useCallback((id: number) => setSelectedTaskId(id), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tasksVersion is a refresh trigger, not a value used inside the effect
  useEffect(() => {
    const controller = new AbortController();
    // Show full loading spinner only on first fetch; show a subtle indicator on subsequent refreshes
    if (!initialized.current) setLoading(true);
    else setRefreshing(true);

    fetch('/api/kanban', { signal: controller.signal })
      .then((r) => r.json())
      .then((raw) => {
        const tasks: KanbanTask[] = raw.tasks.map((t: KanbanTask & { labels: string }) => ({
          ...t,
          labels: (() => {
            if (typeof t.labels !== 'string') return t.labels;
            try {
              return JSON.parse(t.labels) as string[];
            } catch {
              return [];
            }
          })(),
        }));
        setData({ ...raw, tasks });
        initialized.current = true;
        setLoading(false);
        setRefreshing(false);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => controller.abort();
  }, [tasksVersion]);

  const groups = useMemo<SwimlaneGroup[]>(() => {
    if (!data) return [];

    const nonAbandoned = data.tasks.filter((t) => t.status !== 'abandoned');
    const result: SwimlaneGroup[] = [];

    // "No project" row first
    const noProjectTasks = nonAbandoned.filter((t) => t.project === null);
    if (noProjectTasks.length > 0) {
      result.push({ id: null, name: 'No Project', status: 'todo', tasks: noProjectTasks });
    }

    // Active projects first, completed last
    const activeProjects = data.projects.filter((p) => !['done', 'abandoned'].includes(p.status));
    const completedProjects = data.projects.filter((p) => ['done', 'abandoned'].includes(p.status));

    for (const p of [...activeProjects, ...completedProjects]) {
      const projectTasks = nonAbandoned.filter((t) => t.project === p.id);
      result.push({ id: p.id, name: p.name, status: p.status, tasks: projectTasks });
    }

    return result;
  }, [data]);

  const filteredTasks = useMemo<KanbanTask[]>(() => {
    if (!data) return [];
    return data.tasks.filter((t) => {
      if (t.status === 'abandoned') return false;
      if (filterKeyword && !t.title.toLowerCase().includes(filterKeyword.toLowerCase()))
        return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterAssignee !== null && t.assignee !== filterAssignee) return false;
      return true;
    });
  }, [data, filterKeyword, filterPriority, filterAssignee]);

  const toggleCollapse = (groupId: number | null) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const inputStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--borderColor-default)',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    color: 'var(--fgColor-default)',
    outline: 'none',
  };

  if (loading) {
    return (
      <Box sx={{ p: 4, color: 'fg.muted', textAlign: 'center' }}>
        <Text>Loading board...</Text>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box sx={{ p: 4, color: 'fg.muted', textAlign: 'center' }}>
        <Text>Failed to load board data.</Text>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Filter toolbar */}
      <Box
        sx={{
          display: 'flex',
          gap: 2,
          px: 3,
          py: '10px',
          borderBottom: '1px solid',
          borderColor: 'border.default',
          flexShrink: 0,
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Filter by keyword..."
          value={filterKeyword}
          onChange={(e) => setFilterKeyword(e.target.value)}
          style={{ ...inputStyle, width: 200 }}
        />
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="">All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          value={filterAssignee ?? ''}
          onChange={(e) => setFilterAssignee(e.target.value ? Number(e.target.value) : null)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="">All assignees</option>
          {data.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.role}
            </option>
          ))}
        </select>
        {refreshing && (
          <Text sx={{ fontSize: '11px', color: 'fg.subtle', ml: 1 }}>Refreshing...</Text>
        )}
      </Box>

      {/* Board (scrollable) */}
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {/* Sticky column headers */}
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'grid',
            gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`,
            backgroundColor: 'canvas.default',
            borderBottom: '1px solid',
            borderColor: 'border.default',
          }}
        >
          {COLUMNS.map((col) => {
            const count = filteredTasks.filter((t) => t.status === col).length;
            return (
              <Box key={col} sx={{ px: 3, py: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: STATUS_COLORS[col],
                    flexShrink: 0,
                  }}
                />
                <Text sx={{ fontSize: 0, fontWeight: 'semibold', color: 'fg.default' }}>
                  {STATUS_LABELS[col]}
                </Text>
                <Box
                  sx={{
                    px: '5px',
                    borderRadius: 10,
                    backgroundColor: 'neutral.muted',
                    fontSize: '10px',
                    color: 'fg.muted',
                    lineHeight: '18px',
                    minWidth: 20,
                    textAlign: 'center',
                  }}
                >
                  {count}
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Swimlane rows */}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          const total = group.tasks.length;
          const doneCount = group.tasks.filter((t) => t.status === 'done').length;
          const pct = total > 0 ? (doneCount / total) * 100 : 0;

          return (
            <Box
              key={group.id ?? '__no_project__'}
              sx={{ borderBottom: '1px solid', borderColor: 'border.muted' }}
            >
              {/* Swimlane header */}
              <Box
                onClick={() => toggleCollapse(group.id)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  px: 3,
                  py: '10px',
                  cursor: 'pointer',
                  backgroundColor: 'canvas.subtle',
                  borderBottom: isCollapsed ? 'none' : '1px solid',
                  borderColor: 'border.muted',
                  '&:hover': { backgroundColor: 'canvas.overlay' },
                }}
              >
                <Box sx={{ color: 'fg.muted', display: 'flex', alignItems: 'center' }}>
                  {isCollapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
                </Box>
                <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.default' }}>
                  {group.name}
                </Text>
                {group.id !== null && (
                  <Box
                    sx={{
                      px: '5px',
                      py: '1px',
                      borderRadius: 4,
                      border: '1px solid',
                      borderColor: 'border.default',
                      fontSize: '10px',
                      color: 'fg.muted',
                      lineHeight: 1.6,
                    }}
                  >
                    {group.status}
                  </Box>
                )}
                <Text sx={{ fontSize: '11px', color: 'fg.muted' }}>
                  {doneCount}/{total}
                </Text>
                {total > 0 && (
                  <Box sx={{ maxWidth: 100 }}>
                    <Box
                      sx={{
                        height: '4px',
                        borderRadius: 2,
                        backgroundColor: 'border.muted',
                        overflow: 'hidden',
                        width: 80,
                      }}
                    >
                      <Box
                        sx={{
                          height: '100%',
                          width: `${pct}%`,
                          backgroundColor: '#3fb950',
                          borderRadius: 2,
                        }}
                      />
                    </Box>
                  </Box>
                )}
              </Box>

              {/* Card columns */}
              {!isCollapsed && (
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`,
                    alignItems: 'start',
                  }}
                >
                  {COLUMNS.map((col, i) => {
                    const colTasks = filteredTasks.filter(
                      (t) => t.project === group.id && t.status === col
                    );
                    return (
                      <Box
                        key={col}
                        sx={{
                          p: 2,
                          borderRight: i < COLUMNS.length - 1 ? '1px solid' : 'none',
                          borderColor: 'border.muted',
                          minHeight: 60,
                        }}
                      >
                        {colTasks.map((task) => (
                          <KanbanCard
                            key={task.id}
                            task={task}
                            accent={accent}
                            onClick={() => setSelectedTaskId(task.id)}
                          />
                        ))}
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>
          );
        })}

        {/* Empty state */}
        {groups.length === 0 && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 200,
              color: 'fg.muted',
            }}
          >
            <Text>No tasks yet.</Text>
          </Box>
        )}
      </Box>

      {selectedTaskId !== null && (
        <TaskDetailModal
          taskId={selectedTaskId}
          onClose={handleCloseModal}
          onNavigate={handleNavigate}
        />
      )}
    </Box>
  );
}
