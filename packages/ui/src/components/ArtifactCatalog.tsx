/**
 * Artifact Catalog Component
 *
 * Toggleable panel showing all registered artifacts from the database.
 * Groups artifacts by project. Clicking an item opens it in a new tab.
 */

import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from '@primer/octicons-react';
import { Box, Text, TextInput } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_ERROR_BACKOFF_MS, POLL_INTERVAL_MS } from '../constants';
import { useArtifactStore } from '../stores/artifact';
import { useAccentColors } from '../theme/useAccentColors';
import { MultiSelectDropdown } from './MultiSelectDropdown';

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
  const { accent, accentSubtle } = useAccentColors();
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const initialized = useRef(false);
  const tagsInitialized = useRef(false);
  const projectsInitialized = useRef(false);
  const knownTags = useRef<Set<string>>(new Set());
  const knownProjects = useRef<Set<string>>(new Set());

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
          const tags = [...new Set<string>(parsed.flatMap((a: CatalogArtifact) => a.tags))];
          const tagValues = ['', ...tags];
          if (!tagsInitialized.current) {
            tagsInitialized.current = true;
            knownTags.current = new Set(tagValues);
            setSelectedTags(new Set<string>(tagValues));
          } else {
            const newTags = tagValues.filter((t) => !knownTags.current.has(t));
            if (newTags.length > 0) {
              for (const t of newTags) knownTags.current.add(t);
              setSelectedTags((prev) => {
                const next = new Set(prev);
                for (const t of newTags) next.add(t);
                return next;
              });
            }
          }
          const projectNames = [
            ...new Set<string>(
              parsed
                .filter((a: CatalogArtifact) => a.project_name)
                .map((a: CatalogArtifact) => a.project_name as string)
            ),
          ];
          const hasNullProject = parsed.some((a: CatalogArtifact) => !a.project_name);
          const projectValues = [...(hasNullProject ? [''] : []), ...projectNames];
          if (!projectsInitialized.current) {
            projectsInitialized.current = true;
            knownProjects.current = new Set(projectValues);
            setSelectedProjects(new Set<string>(projectValues));
          } else {
            const newProjects = projectValues.filter((p) => !knownProjects.current.has(p));
            if (newProjects.length > 0) {
              for (const p of newProjects) knownProjects.current.add(p);
              setSelectedProjects((prev) => {
                const next = new Set(prev);
                for (const p of newProjects) next.add(p);
                return next;
              });
            }
          }
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
    () => [...new Set(artifacts.map((a) => a.project_name || ''))].filter((p) => p !== '').sort(),
    [artifacts]
  );
  const hasNoProjectArtifacts = artifacts.some((a) => !a.project_name);

  const tagOptions = useMemo(
    () => [{ value: '', label: 'None' }, ...allTags.map((t) => ({ value: t, label: t }))],
    [allTags]
  );
  const projectOptions = useMemo(
    () => [
      ...(hasNoProjectArtifacts ? [{ value: '', label: 'None' }] : []),
      ...allProjects.map((p) => ({ value: p, label: p })),
    ],
    [allProjects, hasNoProjectArtifacts]
  );
  const allTagsSelected = tagOptions.every((o) => selectedTags.has(o.value));
  const allProjectsSelected = projectOptions.every((o) => selectedProjects.has(o.value));

  // Filter artifacts
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return artifacts.filter((a) => {
      if (!allTagsSelected) {
        if (a.tags.length === 0) {
          if (!selectedTags.has('')) return false;
        } else if (!a.tags.some((t) => selectedTags.has(t))) return false;
      }
      if (!allProjectsSelected && !selectedProjects.has(a.project_name || '')) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.project_name?.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [artifacts, query, allTagsSelected, selectedTags, allProjectsSelected, selectedProjects]);

  // Group filtered artifacts by project
  const grouped = useMemo(() => {
    const groups = new Map<string, CatalogArtifact[]>();
    for (const a of filtered) {
      const key = a.project_name || 'No Project';
      const list = groups.get(key) || [];
      list.push(a);
      groups.set(key, list);
    }
    return groups;
  }, [filtered]);

  // Auto-collapse all groups on first data load
  const groupsSeeded = useRef(false);
  useEffect(() => {
    if (!groupsSeeded.current && grouped.size > 0) {
      groupsSeeded.current = true;
      setCollapsedGroups(new Set(grouped.keys()));
    }
  }, [grouped]);

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
        <TextInput
          leadingVisual={SearchIcon}
          placeholder="Search artifacts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          size="small"
          sx={{ fontSize: 0, width: '100%' }}
        />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {projectOptions.length > 0 && (
            <MultiSelectDropdown
              label="projects"
              options={projectOptions}
              selected={selectedProjects}
              onChange={setSelectedProjects}
            />
          )}
          <MultiSelectDropdown
            label="tags"
            options={tagOptions}
            selected={selectedTags}
            onChange={setSelectedTags}
          />
        </Box>
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
                          {artifact.tags.map((tag) => (
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
                                backgroundColor: accentSubtle,
                                color: accent,
                              }}
                            >
                              {tag}
                            </Text>
                          ))}
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
