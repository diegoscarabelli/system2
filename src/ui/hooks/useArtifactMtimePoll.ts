/**
 * Artifact Mtime Poll Hook
 *
 * Polls the server for the active artifact's file modification time.
 * When mtimeMs changes, reloads the tab with a cache-busted URL.
 * Only polls for one file at a time (the active tab).
 */

import { useEffect, useRef } from 'react';
import { useArtifactStore } from '../stores/artifact';

const POLL_INTERVAL_MS = 2000;

export function useArtifactMtimePoll(filePath: string | null): void {
  const lastMtime = useRef<number | null>(null);

  useEffect(() => {
    // Reset mtime when the active file changes
    lastMtime.current = null;

    if (!filePath) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/artifact-mtime?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { mtimeMs: number };

        if (lastMtime.current === null) {
          // First poll: store baseline, don't reload
          lastMtime.current = data.mtimeMs;
          return;
        }

        if (data.mtimeMs !== lastMtime.current) {
          lastMtime.current = data.mtimeMs;
          const freshUrl = `/api/artifact?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
          useArtifactStore.getState().reloadTab(filePath, freshUrl);
        }
      } catch {
        // Network error, skip this tick
      }
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Run first poll immediately to establish baseline
    poll();

    return () => clearInterval(timer);
  }, [filePath]);
}
