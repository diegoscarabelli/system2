/**
 * Artifact Catalog Component
 *
 * Toggleable panel showing all registered artifacts from the database.
 * Groups artifacts by project. Clicking an item opens it in a new tab.
 */

import {
  ChevronDownIcon,
  ChevronRightIcon,
  FilterIcon,
  ProjectIcon,
  SearchIcon,
} from '@primer/octicons-react';
import { ActionList, ActionMenu, Box, IconButton, Text, TextInput } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVAL_MS } from '../constants';
import { useArtifactStore } from '../stores/artifact';
import { useAccentColors } from '../theme/useAccentColors';

interface CatalogArtifactRaw {
  id: number;
  project: number | null;
  file_path: string;
  title: string;
  description: string | null;
  tags: string | null;
  project_name: string | null;
  created_at: string;
}

interface CatalogArtifact extends Omit<CatalogArtifactRaw, 'tags'> {
  tags: string[];
}

export function ArtifactCatalog() {
  const [artifacts, setArtifacts] = useState<CatalogArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const { accent, accentSubtle, accentText } = useAccentColors();
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const fetchData = () => {
      if (!initialized.current) setLoading(true);

      fetch('/api/artifacts', { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          const parsed = (data.artifacts || []).map((a: CatalogArtifactRaw) => {
            let tags: string[] = [];
            if (a.tags) {
              try {
                tags = JSON.parse(a.tags);
              } catch {
                // ignore malformed tags
              }
            }
            return { ...a, tags };
          });
          setArtifacts(parsed);
          initialized.current = true;
          setLoading(false);
          timeoutId = setTimeout(fetchData, POLL_INTERVAL_MS);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== 'AbortError') {
            console.error('Failed to load artifacts:', err);
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

  const handleClick = useCallback(
    (artifact: CatalogArtifact) => {
      const url = `/api/artifact?path=${encodeURIComponent(artifact.file_path)}`;
      openArtifact(url, artifact.title, artifact.file_path);
    },
    [openArtifact]
  );

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const toggleProject = useCallback((project: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroupCollapse = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  // Collect all unique tags and projects
  const allTags = useMemo(() => [...new Set(artifacts.flatMap((a) => a.tags))].sort(), [artifacts]);

  const allProjects = useMemo(
    () => [...new Set(artifacts.map((a) => a.project_name || 'General'))].sort(),
    [artifacts]
  );

  // Filter artifacts
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return artifacts.filter((a) => {
      if (selectedTags.size > 0 && !a.tags.some((t) => selectedTags.has(t))) return false;
      if (selectedProjects.size > 0 && !selectedProjects.has(a.project_name || 'General'))
        return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.project_name?.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [artifacts, query, selectedTags, selectedProjects]);

  // Group filtered artifacts by project
  const grouped = new Map<string, CatalogArtifact[]>();
  for (const a of filtered) {
    const key = a.project_name || 'General';
    const list = grouped.get(key) || [];
    list.push(a);
    grouped.set(key, list);
  }

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
      {/* Title row — matches System2 header height */}
      <Box
        sx={{
          padding: 2,
          borderBottom: '1px solid',
          borderColor: 'border.default',
          flexShrink: 0,
        }}
      >
        <Box as="h2" sx={{ fontSize: 2, fontWeight: 'bold', margin: 0 }}>
          Artifacts
        </Box>
      </Box>

      {/* Search + filters */}
      <Box
        sx={{
          px: 2,
          py: 2,
          borderBottom: '1px solid',
          borderColor: 'border.default',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextInput
            leadingVisual={SearchIcon}
            placeholder="Search artifacts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            size="small"
            sx={{ fontSize: 0, flex: 1 }}
          />
          {allProjects.length > 0 && (
            <ActionMenu>
              <ActionMenu.Anchor>
                <IconButton
                  aria-label="Filter by project"
                  icon={ProjectIcon}
                  variant="invisible"
                  size="small"
                  sx={{ color: selectedProjects.size > 0 ? accent : 'fg.muted' }}
                />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay width="auto" sx={{ maxHeight: '300px', overflow: 'auto' }}>
                <ActionList selectionVariant="multiple">
                  {allProjects.map((project) => (
                    <ActionList.Item
                      key={project}
                      selected={selectedProjects.has(project)}
                      onSelect={() => toggleProject(project)}
                    >
                      {project}
                    </ActionList.Item>
                  ))}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          )}
          {allTags.length > 0 && (
            <ActionMenu>
              <ActionMenu.Anchor>
                <IconButton
                  aria-label="Filter by tag"
                  icon={FilterIcon}
                  variant="invisible"
                  size="small"
                  sx={{ color: selectedTags.size > 0 ? accent : 'fg.muted' }}
                />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay width="auto" sx={{ maxHeight: '300px', overflow: 'auto' }}>
                <ActionList selectionVariant="multiple">
                  {allTags.map((tag) => (
                    <ActionList.Item
                      key={tag}
                      selected={selectedTags.has(tag)}
                      onSelect={() => toggleTag(tag)}
                    >
                      {tag}
                    </ActionList.Item>
                  ))}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          )}
        </Box>
        {(selectedTags.size > 0 || selectedProjects.size > 0) && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {[...selectedProjects].map((project) => (
              <Text
                key={`p:${project}`}
                onClick={() => toggleProject(project)}
                sx={{
                  fontSize: '10px',
                  px: 1,
                  py: '1px',
                  borderRadius: 2,
                  cursor: 'pointer',
                  backgroundColor: accent,
                  color: accentText,
                }}
              >
                {project} ×
              </Text>
            ))}
            {[...selectedTags].map((tag) => (
              <Text
                key={`t:${tag}`}
                onClick={() => toggleTag(tag)}
                sx={{
                  fontSize: '10px',
                  px: 1,
                  py: '1px',
                  borderRadius: 2,
                  cursor: 'pointer',
                  backgroundColor: accent,
                  color: accentText,
                }}
              >
                {tag} ×
              </Text>
            ))}
          </Box>
        )}
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {loading && <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Loading...</Text>}

        {!loading && artifacts.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 0 }}>No artifacts registered.</Text>
        )}

        {!loading && artifacts.length > 0 && filtered.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 0 }}>No artifacts match filters.</Text>
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
                  items.map((artifact) => (
                    <Box
                      key={artifact.id}
                      onClick={() => handleClick(artifact)}
                      sx={{
                        p: 2,
                        mb: 1,
                        borderRadius: 2,
                        cursor: 'pointer',
                        '&:hover': { backgroundColor: 'canvas.subtle' },
                      }}
                    >
                      <Text sx={{ fontSize: 1, display: 'block' }}>{artifact.title}</Text>
                      {artifact.description && (
                        <Text
                          sx={{
                            fontSize: 0,
                            color: 'fg.muted',
                            display: '-webkit-box',
                            mt: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                          }}
                        >
                          {artifact.description}
                        </Text>
                      )}
                      {artifact.tags.length > 0 && (
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                          {artifact.tags.map((tag) => {
                            const active = selectedTags.has(tag);
                            return (
                              <Text
                                key={tag}
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  toggleTag(tag);
                                }}
                                sx={{
                                  fontSize: '10px',
                                  px: 1,
                                  py: '1px',
                                  borderRadius: 2,
                                  cursor: 'pointer',
                                  backgroundColor: active ? accent : accentSubtle,
                                  color: active ? accentText : accent,
                                }}
                              >
                                {tag}
                              </Text>
                            );
                          })}
                        </Box>
                      )}
                    </Box>
                  ))}
              </Box>
            );
          })}
      </Box>
    </Box>
  );
}
