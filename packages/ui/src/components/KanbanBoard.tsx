/**
 * KanbanBoard Component
 *
 * Live kanban dashboard showing tasks grouped by project in a swimlane layout.
 * Fetches from /api/kanban on mount and refetches on WebSocket push notifications.
 */

import { ChevronDownIcon, ChevronRightIcon, InfoIcon, SearchIcon } from '@primer/octicons-react';
import { Box, IconButton, Text, TextInput } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePushFetch } from '../hooks/usePushFetch';
import { usePushStore } from '../stores/push';
import { colors } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';
import { FetchErrorBanner } from './FetchErrorBanner';
import { MultiSelectDropdown } from './MultiSelectDropdown';
import { ProjectDetailModal } from './ProjectDetailModal';
import { TaskDetailModal } from './TaskDetailModal';

const COLUMNS = ['todo', 'in progress', 'review', 'done', 'abandoned'] as const;
type Column = (typeof COLUMNS)[number];

const STATUS_LABELS: Record<Column, string> = {
  todo: 'Todo',
  'in progress': 'In Progress',
  review: 'Review',
  done: 'Done',
  abandoned: 'Abandoned',
};

function statusColorForColumn(col: string, accent: string, highlight: string): string {
  if (col === 'todo') return colors.gray;
  if (col === 'in progress') return accent;
  if (col === 'review') return highlight;
  return colors.teal;
}

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
  description: string;
  status: string;
  labels: string;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  updated_at: string;
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
  return colors.teal;
}

function KanbanCard({
  task,
  accent,
  highlight,
  onClick,
}: {
  task: KanbanTask;
  accent: string;
  highlight: string;
  onClick: () => void;
}) {
  const stripeColor = statusColorForColumn(task.status, accent, highlight);
  const prioColor = priorityColor(task.priority, accent);
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
      <Text sx={{ fontWeight: 'bold', fontSize: 1, lineHeight: 1.3, color: 'fg.default' }}>
        <Text as="span" sx={{ color: 'fg.muted' }}>
          #{task.id}
        </Text>{' '}
        {task.title}
      </Text>
      {task.labels.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
          {task.labels.map((label) => (
            <Box
              key={label}
              sx={{
                fontSize: '11px',
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
      <Box
        sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: '2px' }}
      >
        <Text sx={{ fontSize: '11px', color: prioColor }}>{task.priority}</Text>
        {task.assignee_role && (
          <Text sx={{ fontSize: '11px', color: 'fg.default' }}>
            {task.assignee_role}_{task.assignee}
          </Text>
        )}
      </Box>
    </Box>
  );
}

const ALL_PRIORITIES = new Set(['high', 'medium', 'low']);
const ALL_STATUSES = new Set(['todo', 'in progress', 'review', 'done', 'abandoned']);

export function KanbanBoard() {
  const { accent, highlight } = useAccentColors();
  const [data, setData] = useState<KanbanData | null>(null);
  const boardVersion = usePushStore((s) => s.boardVersion);
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterPriorities, setFilterPriorities] = useState<Set<string>>(new Set(ALL_PRIORITIES));
  const [filterAssignees, setFilterAssignees] = useState<Set<string>>(new Set());
  const [filterStatuses, setFilterStatuses] = useState<Set<string>>(new Set(ALL_STATUSES));
  const [filterLabels, setFilterLabels] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number | null>>(new Set());
  const collapsedInitialized = useRef(false);
  const assigneesInitialized = useRef(false);
  const labelsInitialized = useRef(false);
  const knownAssignees = useRef<Set<string>>(new Set());
  const knownLabels = useRef<Set<string>>(new Set());

  // Auto-collapse done/abandoned projects on first load
  useEffect(() => {
    if (!data || collapsedInitialized.current) return;
    collapsedInitialized.current = true;
    const doneIds = data.projects
      .filter((p) => p.status === 'done' || p.status === 'abandoned')
      .map((p) => p.id);
    if (doneIds.length > 0) {
      setCollapsed(new Set(doneIds));
    }
  }, [data]);

  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const handleCloseModal = useCallback(() => setSelectedTaskId(null), []);
  const handleNavigate = useCallback((id: number) => setSelectedTaskId(id), []);
  const handleCloseProjectModal = useCallback(() => setSelectedProjectId(null), []);

  const handleData = useCallback(
    (raw: {
      tasks: (KanbanTask & { labels: string })[];
      projects: KanbanProject[];
      agents: KanbanAgent[];
    }) => {
      const tasks: KanbanTask[] = raw.tasks.map((t) => ({
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
      const agentValues = ['', ...raw.agents.map((a: KanbanAgent) => String(a.id))];
      if (!assigneesInitialized.current) {
        assigneesInitialized.current = true;
        knownAssignees.current = new Set(agentValues);
        setFilterAssignees(new Set(agentValues));
      } else {
        const newAssignees = agentValues.filter((v) => !knownAssignees.current.has(v));
        if (newAssignees.length > 0) {
          for (const v of newAssignees) knownAssignees.current.add(v);
          setFilterAssignees((prev) => {
            const next = new Set(prev);
            for (const v of newAssignees) next.add(v);
            return next;
          });
        }
      }
      const labelValues = ['', ...new Set(tasks.flatMap((t: KanbanTask) => t.labels))];
      if (!labelsInitialized.current) {
        labelsInitialized.current = true;
        knownLabels.current = new Set(labelValues);
        setFilterLabels(new Set(labelValues));
      } else {
        const newLabels = labelValues.filter((v) => !knownLabels.current.has(v));
        if (newLabels.length > 0) {
          for (const v of newLabels) knownLabels.current.add(v);
          setFilterLabels((prev) => {
            const next = new Set(prev);
            for (const v of newLabels) next.add(v);
            return next;
          });
        }
      }
    },
    []
  );

  const { loading, error, retry } = usePushFetch('/api/kanban', boardVersion, handleData);

  // Visible columns based on status filter
  const visibleColumns = useMemo(() => {
    const allSelected = filterStatuses.size === ALL_STATUSES.size;
    if (allSelected) return COLUMNS;
    return COLUMNS.filter((col) => filterStatuses.has(col));
  }, [filterStatuses]);

  const groups = useMemo<SwimlaneGroup[]>(() => {
    if (!data) return [];

    const result: SwimlaneGroup[] = [];

    // "No project" row first
    const noProjectTasks = data.tasks.filter((t) => t.project === null);
    if (noProjectTasks.length > 0) {
      result.push({ id: null, name: 'No Project', status: 'todo', tasks: noProjectTasks });
    }

    // Active projects first, completed/abandoned last
    const activeProjects = data.projects.filter((p) => !['done', 'abandoned'].includes(p.status));
    const completedProjects = data.projects.filter((p) => ['done', 'abandoned'].includes(p.status));

    for (const p of [...activeProjects, ...completedProjects]) {
      const projectTasks = data.tasks.filter((t) => t.project === p.id);
      result.push({ id: p.id, name: p.name, status: p.status, tasks: projectTasks });
    }

    return result;
  }, [data]);

  const allLabels = useMemo(
    () => [...new Set((data?.tasks ?? []).flatMap((t) => t.labels))].sort(),
    [data]
  );

  const priorityOptions = [
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
  ];

  const assigneeOptions = [
    { value: '', label: 'None' },
    ...(data ? data.agents.map((a) => ({ value: String(a.id), label: `${a.role}_${a.id}` })) : []),
  ];

  const labelOptions = [
    { value: '', label: 'None' },
    ...allLabels.map((l) => ({ value: l, label: l })),
  ];

  const statusOptions = [
    { value: 'todo', label: 'Todo' },
    { value: 'in progress', label: 'In Progress' },
    { value: 'review', label: 'Review' },
    { value: 'done', label: 'Done' },
    { value: 'abandoned', label: 'Abandoned' },
  ];

  const allPrioritiesSelected = priorityOptions.every((o) => filterPriorities.has(o.value));
  const allAssigneesSelected = assigneeOptions.every((o) => filterAssignees.has(o.value));
  const allLabelsSelected = labelOptions.every((o) => filterLabels.has(o.value));

  const filteredTasks = useMemo<KanbanTask[]>(() => {
    if (!data) return [];
    return data.tasks.filter((t) => {
      if (filterKeyword && !t.title.toLowerCase().includes(filterKeyword.toLowerCase()))
        return false;
      if (!allPrioritiesSelected && !filterPriorities.has(t.priority)) return false;
      if (!allAssigneesSelected && !filterAssignees.has(String(t.assignee ?? ''))) return false;
      if (!allLabelsSelected) {
        if (t.labels.length === 0) {
          if (!filterLabels.has('')) return false;
        } else if (!t.labels.some((l) => filterLabels.has(l))) return false;
      }
      return true;
    });
  }, [
    data,
    filterKeyword,
    allPrioritiesSelected,
    filterPriorities,
    allAssigneesSelected,
    filterAssignees,
    allLabelsSelected,
    filterLabels,
  ]);

  const toggleCollapse = (groupId: number | null) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  if (loading) {
    return (
      <Box sx={{ p: 4, color: 'fg.muted', textAlign: 'center' }}>
        <Text>Loading board...</Text>
      </Box>
    );
  }

  if (!data && error) {
    return (
      <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <FetchErrorBanner message={error} onRetry={retry} />
      </Box>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {error && <FetchErrorBanner message={error} onRetry={retry} />}
      {/* Filter toolbar */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 2,
          px: 3,
          py: '10px',
          borderBottom: '1px solid',
          borderColor: 'border.default',
          flexShrink: 0,
          alignItems: 'center',
        }}
      >
        <TextInput
          leadingVisual={SearchIcon}
          placeholder="Filter by keyword..."
          value={filterKeyword}
          onChange={(e) => setFilterKeyword(e.target.value)}
          size="small"
          sx={{ fontSize: 0, width: 300, minWidth: 150, flexShrink: 1 }}
        />
        <MultiSelectDropdown
          label="priorities"
          options={priorityOptions}
          selected={filterPriorities}
          onChange={setFilterPriorities}
        />
        <MultiSelectDropdown
          label="assignees"
          options={assigneeOptions}
          selected={filterAssignees}
          onChange={setFilterAssignees}
        />
        <MultiSelectDropdown
          label="labels"
          options={labelOptions}
          selected={filterLabels}
          onChange={setFilterLabels}
        />
        <MultiSelectDropdown
          label="statuses"
          options={statusOptions}
          selected={filterStatuses}
          onChange={setFilterStatuses}
        />
      </Box>

      {/* Board wrapper: horizontal scroll for both headers and content */}
      <Box sx={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', minHeight: 0 }}>
        <Box
          sx={{
            minWidth: `${visibleColumns.length * 180}px`,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
          }}
        >
          {/* Column headers */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(${visibleColumns.length}, 1fr)`,
              borderBottom: '1px solid',
              borderColor: 'border.default',
              flexShrink: 0,
              overflow: 'hidden',
              scrollbarGutter: 'stable',
            }}
          >
            {visibleColumns.map((col, i) => {
              const count = filteredTasks.filter((t) => t.status === col).length;
              return (
                <Box
                  key={col}
                  sx={{
                    px: 3,
                    py: 2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    borderRight: i < visibleColumns.length - 1 ? '1px solid' : 'none',
                    borderColor: 'border.muted',
                  }}
                >
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: statusColorForColumn(col, accent, highlight),
                      flexShrink: 0,
                    }}
                  />
                  <Text sx={{ fontSize: 1, fontWeight: 'semibold', color: 'fg.default' }}>
                    {STATUS_LABELS[col]}
                  </Text>
                  <Box
                    sx={{
                      px: '5px',
                      borderRadius: 10,
                      backgroundColor: 'neutral.muted',
                      fontSize: '11px',
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

          {/* Swimlane rows (vertical scroll) */}
          <Box sx={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable' }}>
            {/* Swimlane rows */}
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.id);
              const total = group.tasks.length;
              const completedCount = group.tasks.filter(
                (t) => t.status === 'done' || t.status === 'abandoned'
              ).length;
              const statusCounts = {
                done: group.tasks.filter((t) => t.status === 'done').length,
                review: group.tasks.filter((t) => t.status === 'review').length,
                'in progress': group.tasks.filter((t) => t.status === 'in progress').length,
                todo: group.tasks.filter((t) => t.status === 'todo').length,
                abandoned: group.tasks.filter((t) => t.status === 'abandoned').length,
              };

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
                      backgroundColor: 'transparent',
                      borderBottom: isCollapsed ? 'none' : '1px solid',
                      borderColor: 'border.muted',
                      '&:hover': { backgroundColor: 'canvas.subtle' },
                    }}
                  >
                    <Box sx={{ color: 'fg.muted', display: 'flex', alignItems: 'center' }}>
                      {isCollapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
                    </Box>
                    <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.default' }}>
                      {group.name}
                    </Text>
                    {group.id !== null && (
                      <IconButton
                        aria-label="Project details"
                        icon={InfoIcon}
                        variant="invisible"
                        size="small"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setSelectedProjectId(group.id);
                        }}
                        sx={{ color: 'fg.muted', p: 0, height: 20, width: 20 }}
                      />
                    )}
                    {group.id !== null &&
                      (() => {
                        const sc = statusColorForColumn(group.status, accent, highlight);
                        return (
                          <Box
                            sx={{
                              px: '5px',
                              py: '1px',
                              borderRadius: 4,
                              backgroundColor: `${sc}22`,
                              border: `1px solid ${sc}44`,
                              fontSize: '11px',
                              color: sc,
                              lineHeight: 1.6,
                            }}
                          >
                            {group.status}
                          </Box>
                        );
                      })()}
                    <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                      {completedCount}/{total}
                    </Text>
                    {total > 0 && (
                      <Box
                        sx={{
                          height: '4px',
                          borderRadius: 2,
                          backgroundColor: 'border.muted',
                          overflow: 'hidden',
                          width: 80,
                          display: 'flex',
                        }}
                      >
                        {COLUMNS.filter((col) => statusCounts[col] > 0).map((col) => (
                          <Box
                            key={col}
                            sx={{
                              height: '100%',
                              width: `${(statusCounts[col] / total) * 100}%`,
                              backgroundColor: statusColorForColumn(col, accent, highlight),
                            }}
                          />
                        ))}
                      </Box>
                    )}
                  </Box>

                  {/* Card columns */}
                  {!isCollapsed && (
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${visibleColumns.length}, 1fr)`,
                      }}
                    >
                      {visibleColumns.map((col, i) => {
                        const colTasks = filteredTasks.filter(
                          (t) => t.project === group.id && t.status === col
                        );
                        return (
                          <Box
                            key={col}
                            sx={{
                              p: 2,
                              borderRight: i < visibleColumns.length - 1 ? '1px solid' : 'none',
                              borderColor: 'border.muted',
                              minHeight: 60,
                            }}
                          >
                            {colTasks.map((task) => (
                              <KanbanCard
                                key={task.id}
                                task={task}
                                accent={accent}
                                highlight={highlight}
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
        </Box>
      </Box>

      {selectedTaskId !== null && (
        <TaskDetailModal
          taskId={selectedTaskId}
          onClose={handleCloseModal}
          onNavigate={handleNavigate}
        />
      )}

      {selectedProjectId !== null &&
        (() => {
          const project = data?.projects.find((p) => p.id === selectedProjectId);
          return project ? (
            <ProjectDetailModal project={project} onClose={handleCloseProjectModal} />
          ) : null;
        })()}
    </Box>
  );
}
