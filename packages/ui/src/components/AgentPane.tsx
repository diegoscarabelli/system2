/**
 * Agent Pane Component
 *
 * Toggleable panel showing all active agents with busy/idle indicators.
 * Groups agents by: system singletons first, then by project.
 */

import { ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { Box, Text } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVAL_MS } from '../constants';
import { useArtifactStore } from '../stores/artifact';
import { colors } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';

interface AgentInfo {
  id: number;
  role: string;
  project: number | null;
  project_name: string | null;
  status: string;
  busy: boolean;
  created_at: string;
}

const COLS = ['ID', 'Role', 'Context %', 'State'] as const;

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
            textAlign: col === 'State' ? 'center' : 'left',
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

function contextColor(percent: number, accent: string): string {
  if (percent >= 90) return colors.coral;
  if (percent >= 60) return accent;
  return colors.teal;
}

export function AgentPane() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const agentContextPercents = useArtifactStore((s) => s.agentContextPercents);
  const { accent } = useAccentColors();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const fetchData = () => {
      if (!initialized.current) setLoading(true);

      fetch('/api/agents', { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          setAgents(data.agents || []);
          initialized.current = true;
          setLoading(false);
          timeoutId = setTimeout(fetchData, POLL_INTERVAL_MS);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== 'AbortError') {
            console.error('Failed to load agents:', err);
            setLoading(false);
            timeoutId = setTimeout(fetchData, POLL_INTERVAL_MS);
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

  // Group agents: system singletons first, then by project
  const grouped = useMemo(() => {
    const groups = new Map<string, AgentInfo[]>();

    const system = agents.filter((a) => a.project === null);
    if (system.length > 0) groups.set('System', system);

    const projectAgents = agents.filter((a) => a.project !== null);
    for (const agent of projectAgents) {
      const key = agent.project_name || `Project #${agent.project}`;
      const list = groups.get(key) || [];
      list.push(agent);
      groups.set(key, list);
    }

    return groups;
  }, [agents]);

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
          Agents
        </Box>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {loading && (
          <Text sx={{ color: 'fg.muted', fontSize: 0, p: 2, display: 'block' }}>Loading...</Text>
        )}

        {!loading && agents.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 0, p: 2, display: 'block' }}>
            No active agents.
          </Text>
        )}

        {!loading &&
          agents.length > 0 &&
          [...grouped.entries()].map(([group, items]) => {
            const isCollapsed = collapsedGroups.has(group);
            return (
              <Box
                key={group}
                as="table"
                sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 0, mb: 3 }}
              >
                <Box as="thead">
                  {/* Group header row */}
                  <Box
                    as="tr"
                    onClick={() => toggleGroupCollapse(group)}
                    sx={{ cursor: 'pointer', '&:hover td': { color: 'fg.default' } }}
                  >
                    <Box
                      as="td"
                      colSpan={4}
                      sx={{
                        px: 2,
                        py: 1,
                        color: 'fg.muted',
                        borderBottom: '1px solid',
                        borderColor: 'border.muted',
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
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
                  {/* Column headers */}
                  {!isCollapsed && <TableHeaders />}
                </Box>
                {!isCollapsed && (
                  <Box as="tbody">
                    {items.map((agent) => (
                      <Box
                        key={agent.id}
                        as="tr"
                        sx={{
                          '&:hover': { backgroundColor: 'canvas.subtle' },
                          '&:last-child td': { borderBottom: 'none' },
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
                          }}
                        >
                          {agent.id}
                        </Box>
                        <Box
                          as="td"
                          sx={{
                            px: 2,
                            py: 1,
                            borderBottom: '1px solid',
                            borderColor: 'border.muted',
                            textTransform: 'capitalize',
                            width: '100%',
                          }}
                        >
                          {agent.role}
                        </Box>
                        <Box
                          as="td"
                          sx={{
                            px: 2,
                            py: 1,
                            borderBottom: '1px solid',
                            borderColor: 'border.muted',
                            whiteSpace: 'nowrap',
                            color:
                              agentContextPercents[agent.id] != null
                                ? contextColor(agentContextPercents[agent.id] as number, accent)
                                : 'fg.muted',
                          }}
                        >
                          {agentContextPercents[agent.id] != null
                            ? Math.round(agentContextPercents[agent.id] as number)
                            : '—'}
                        </Box>
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
                              backgroundColor: agent.busy ? colors.teal : colors.gray,
                              display: 'inline-block',
                            }}
                          />
                        </Box>
                      </Box>
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
