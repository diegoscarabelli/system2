/**
 * TaskDetailModal Component
 *
 * Overlay modal showing full task details, comments, and linked tasks.
 * Opened from the KanbanBoard when a card is clicked.
 */

import { XIcon } from '@primer/octicons-react';
import { Box, IconButton, Text } from '@primer/react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { POLL_ERROR_BACKOFF_MS, POLL_INTERVAL_MS } from '../constants';
import { colors } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';

interface TaskDetail {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: 'low' | 'medium' | 'high';
  assignee: number | null;
  labels: string;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  project_name: string | null;
  assignee_role: string | null;
}

interface TaskComment {
  id: number;
  task: number;
  author: number;
  content: string;
  created_at: string;
  author_role: string;
}

interface TaskLink {
  id: number;
  relationship: string;
  linked_task_id: number;
  linked_task_title: string;
  linked_task_status: string;
  direction: 'outgoing' | 'incoming';
}

interface TaskDetailData {
  task: TaskDetail;
  comments: TaskComment[];
  links: TaskLink[];
}

function statusColor(status: string, accent: string, highlight: string): string {
  if (status === 'todo') return colors.gray;
  if (status === 'in progress') return accent;
  if (status === 'review') return highlight;
  if (status === 'done') return colors.teal;
  return colors.gray;
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  blocked_by: 'Blocked by',
  relates_to: 'Relates to',
  duplicates: 'Duplicates',
};

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

function PriorityBadge({ priority, accent }: { priority: string; accent: string }) {
  const c = priority === 'high' ? colors.coral : priority === 'medium' ? accent : colors.teal;
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: '8px',
        py: '2px',
        borderRadius: 10,
        backgroundColor: `${c}22`,
        border: `1px solid ${c}44`,
        fontSize: '11px',
        color: c,
        fontWeight: 'semibold',
        lineHeight: 1.6,
      }}
    >
      {priority}
    </Box>
  );
}

export function TaskDetailModal({
  taskId,
  onClose,
  onNavigate,
}: {
  taskId: number;
  onClose: () => void;
  onNavigate: (id: number) => void;
}) {
  const { accent, highlight } = useAccentColors();
  const [data, setData] = useState<TaskDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;
    initialized.current = false;

    if (panelRef.current) panelRef.current.scrollTop = 0;

    const fetchData = () => {
      if (!initialized.current) {
        setLoading(true);
        setData(null);
      }

      fetch(`/api/tasks/${taskId}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((d: TaskDetailData) => {
          setData(d);
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
  }, [taskId]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const task = data?.task;
  const labels: string[] = (() => {
    if (!task?.labels) return [];
    if (typeof task.labels !== 'string') return task.labels as unknown as string[];
    try {
      return JSON.parse(task.labels) as string[];
    } catch {
      return [];
    }
  })();

  // Group links by relationship
  const linksByRelationship = (data?.links ?? []).reduce<Record<string, TaskLink[]>>(
    (acc, link) => {
      const key = link.relationship;
      if (!acc[key]) acc[key] = [];
      acc[key].push(link);
      return acc;
    },
    {}
  );

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
            {loading ? (
              <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Loading...</Text>
            ) : (
              <Text sx={{ fontWeight: 'bold', fontSize: 3, color: 'fg.default', lineHeight: 1.3 }}>
                <Text as="span" sx={{ color: 'fg.muted' }}>
                  #{task?.id}
                </Text>{' '}
                {task?.title ?? 'Task not found'}
              </Text>
            )}
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

        {task && (
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
                <StatusBadge status={task.status} accent={accent} highlight={highlight} />
              </dd>
              <dt>Priority:</dt>
              <dd>
                <PriorityBadge priority={task.priority} accent={accent} />
              </dd>
              <dt>Assignee:</dt>
              <dd>{task.assignee_role ? `${task.assignee_role}_${task.assignee}` : ''}</dd>
              <dt>Project:</dt>
              <dd>{task.project_name ?? ''}</dd>
              <dt>Labels:</dt>
              <dd>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {labels.map((label) => (
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
                  ))}
                </Box>
              </dd>
              <dt>Started:</dt>
              <dd>{task.start_at ? formatDate(task.start_at) : ''}</dd>
              <dt>Completed:</dt>
              <dd>{task.end_at ? formatDate(task.end_at) : ''}</dd>
            </Box>

            {/* Description */}
            {task.description && (
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
                  <Markdown>{task.description}</Markdown>
                </Box>
              </Box>
            )}

            {/* Task links */}
            {Object.keys(linksByRelationship).length > 0 && (
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
                  Links:
                </Text>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {Object.entries(linksByRelationship).map(([rel, links]) => (
                    <Box key={rel}>
                      <Text sx={{ fontSize: '11px', color: 'fg.muted', mb: 1, display: 'block' }}>
                        {RELATIONSHIP_LABELS[rel] ?? rel}
                      </Text>
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {links.map((link) => (
                          <Box
                            key={link.id}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 2,
                              px: 2,
                              py: 1,
                              borderRadius: 1,
                              border: '1px solid',
                              borderColor: 'border.muted',
                              cursor: 'pointer',
                              '&:hover': { backgroundColor: 'canvas.subtle' },
                            }}
                            onClick={() => onNavigate(link.linked_task_id)}
                          >
                            <StatusBadge
                              status={link.linked_task_status}
                              accent={accent}
                              highlight={highlight}
                            />
                            <Text
                              sx={{
                                fontSize: 0,
                                color: 'fg.default',
                                '&:hover': { color: accent },
                              }}
                            >
                              {link.linked_task_title}
                            </Text>
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            )}

            {/* Comments */}
            {data.comments.length > 0 && (
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
                  Comments:
                </Text>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {data.comments.map((comment) => (
                    <Box
                      key={comment.id}
                      sx={{
                        borderLeft: `2px solid ${accent}`,
                        pl: 3,
                        py: 1,
                      }}
                    >
                      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 1 }}>
                        <Text
                          sx={{
                            fontSize: '11px',
                            fontWeight: 'semibold',
                            color: accent,
                          }}
                        >
                          {comment.author_role}_{comment.author}
                        </Text>
                        <Text sx={{ fontSize: '11px', color: 'fg.subtle' }}>
                          {formatDate(comment.created_at)}
                        </Text>
                      </Box>
                      <Box
                        sx={{
                          fontSize: 0,
                          color: 'fg.default',
                          lineHeight: 1.6,
                          '& p': { m: 0, mb: 1 },
                          '& p:last-child': { mb: 0 },
                          '& code': {
                            fontFamily: 'mono',
                            fontSize: '11px',
                            px: '4px',
                            py: '1px',
                            borderRadius: 2,
                            backgroundColor: 'canvas.subtle',
                          },
                        }}
                      >
                        <Markdown>{comment.content}</Markdown>
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
