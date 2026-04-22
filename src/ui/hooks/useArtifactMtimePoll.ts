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
    lastMtime.current = null;

    if (!filePath) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/artifact-mtime?path=${encodeURIComponent(filePath)}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (controller.signal.aborted) return;

        if (res.ok) {
          const data = (await res.json()) as { mtimeMs: number };
          if (controller.signal.aborted) return;

          if (lastMtime.current === null) {
            lastMtime.current = data.mtimeMs;
          } else if (data.mtimeMs !== lastMtime.current) {
            lastMtime.current = data.mtimeMs;
            const freshUrl = `/api/artifact?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
            useArtifactStore.getState().reloadTab(filePath, freshUrl);
          }
        }
      } catch {
        // Network or abort error, skip this tick
      }

      if (!controller.signal.aborted) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();

    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [filePath]);
}
