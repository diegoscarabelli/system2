/**
 * Artifact Catalog Component
 *
 * Toggleable overlay panel showing all registered artifacts from the database.
 * Groups artifacts by project. Clicking an item opens it in a new tab.
 */

import { XIcon } from '@primer/octicons-react';
import { Box, IconButton, Text } from '@primer/react';
import { useCallback, useEffect, useState } from 'react';
import { useArtifactStore } from '../stores/artifact';

interface CatalogArtifact {
  id: number;
  project: number | null;
  file_path: string;
  title: string;
  description: string | null;
  tags: string[];
  project_name: string | null;
  created_at: string;
}

export function ArtifactCatalog() {
  const [artifacts, setArtifacts] = useState<CatalogArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const toggleCatalog = useArtifactStore((s) => s.toggleCatalog);
  const openArtifact = useArtifactStore((s) => s.openArtifact);

  useEffect(() => {
    setLoading(true);
    fetch('/api/artifacts')
      .then((res) => res.json())
      .then((data) => setArtifacts(data.artifacts || []))
      .catch((err) => console.error('Failed to load artifacts:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleClick = useCallback(
    (artifact: CatalogArtifact) => {
      const url = `/api/artifact?path=${encodeURIComponent(artifact.file_path)}`;
      openArtifact(url, artifact.title, artifact.file_path);
      toggleCatalog();
    },
    [openArtifact, toggleCatalog]
  );

  // Group by project
  const grouped = new Map<string, CatalogArtifact[]>();
  for (const a of artifacts) {
    const key = a.project_name || 'General';
    const list = grouped.get(key) || [];
    list.push(a);
    grouped.set(key, list);
  }

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        bottom: 0,
        width: 320,
        backgroundColor: 'canvas.default',
        borderRight: '1px solid',
        borderColor: 'border.default',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
        boxShadow: 'shadow.large',
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 3,
          py: 2,
          borderBottom: '1px solid',
          borderColor: 'border.default',
        }}
      >
        <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>Artifacts</Text>
        <IconButton
          aria-label="Close catalog"
          icon={XIcon}
          variant="invisible"
          onClick={toggleCatalog}
          sx={{ color: 'fg.muted' }}
        />
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {loading && (
          <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Loading...</Text>
        )}

        {!loading && artifacts.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 0 }}>No artifacts registered.</Text>
        )}

        {!loading &&
          [...grouped.entries()].map(([group, items]) => (
            <Box key={group} sx={{ mb: 3 }}>
              <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted', mb: 1, display: 'block' }}>
                {group}
              </Text>
              {items.map((artifact) => (
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
                        display: 'block',
                        mt: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {artifact.description}
                    </Text>
                  )}
                </Box>
              ))}
            </Box>
          ))}
      </Box>
    </Box>
  );
}
