/**
 * Shared hook for push-triggered panel fetches with error state and retry.
 *
 * Encapsulates the version-counter refetch pattern used by all push-driven panels.
 * On failure, exposes an error message and a retry function so the panel can
 * show an inline banner instead of silently swallowing the error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function usePushFetch<T>(
  url: string,
  version: number,
  onData: (data: T) => void
): { loading: boolean; error: string | null; retry: () => void } {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  const lastUrl = useRef(url);
  const [retryCount, setRetryCount] = useState(0);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // Reset when URL changes so a new resource starts fresh
  if (lastUrl.current !== url) {
    lastUrl.current = url;
    initialized.current = false;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: version and retryCount are intentional refetch triggers
  useEffect(() => {
    const controller = new AbortController();

    if (!initialized.current) setLoading(true);

    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data: T) => {
        onDataRef.current(data);
        initialized.current = true;
        setLoading(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setLoading(false);
          setError(err instanceof Error ? err.message : 'Fetch failed');
        }
      });

    return () => controller.abort();
  }, [url, version, retryCount]);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  return { loading, error, retry };
}
