/**
 * Agent Pane Component
 *
 * Toggleable panel showing all active agents with busy/idle indicators.
 * Groups agents by: system singletons first, then by project.
 */

import { ChevronDownIcon, ChevronRightIcon } from '@primer/octicons-react';
import { Box, Text } from '@primer/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useArtifactStore } from '../stores/artifact';
import { colors } from '../theme/colors';

interface AgentInfo {
  id: number;
  role: string;
  project: number | null;
  project_name: string | null;
  status: string;
  busy: boolean;
  created_at: string;
}

export function AgentPane() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const agentsVersion = useArtifactStore((s) => s.agentsVersion);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: agentsVersion is an intentional external trigger to re-fetch
  useEffect(() => {
    fetch('/api/agents')
      .then((res) => res.json())
      .then((data) => setAgents(data.agents || []))
      .catch((err) => console.error('Failed to load agents:', err))
      .finally(() => setLoading(false));
  }, [agentsVersion]);

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

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {loading && <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Loading...</Text>}

        {!loading && agents.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 0 }}>No active agents.</Text>
        )}

        {!loading &&
          [...grouped.entries()].map(([group, items]) => {
            const isCollapsed = collapsedGroups.has(group);
            return (
              <Box key={group} sx={{ mb: 2 }}>
                <Box
                  onClick={() => toggleGroupCollapse(group)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    cursor: 'pointer',
                    py: 1,
                    color: 'fg.muted',
                    '&:hover': { color: 'fg.default' },
                  }}
                >
                  {isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
                  <Text sx={{ fontSize: 0, fontWeight: 'bold' }}>{group}</Text>
                  <Text sx={{ fontSize: 0, ml: 'auto' }}>{items.length}</Text>
                </Box>
                {!isCollapsed &&
                  items.map((agent) => (
                    <Box
                      key={agent.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                        py: 1,
                        px: 2,
                        borderRadius: 2,
                      }}
                    >
                      <Box
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: agent.busy ? colors.teal : colors.gray,
                          flexShrink: 0,
                        }}
                      />
                      <Text sx={{ fontSize: 1, textTransform: 'capitalize' }}>{agent.role}</Text>
                      <Text sx={{ fontSize: 0, color: 'fg.muted', ml: 'auto' }}>#{agent.id}</Text>
                    </Box>
                  ))}
              </Box>
            );
          })}
      </Box>
    </Box>
  );
}
