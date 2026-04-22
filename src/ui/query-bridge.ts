/**
 * Query Bridge
 *
 * Handles postMessage bridge communication between HTML artifact iframes
 * and the System2 server query endpoint. Extracted from ArtifactViewer
 * for testability.
 */

export type PostMessageFn = (message: unknown, targetOrigin: string) => void;

export async function handleQueryMessage(
  data: Record<string, unknown> | undefined,
  postMessage: PostMessageFn,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const { type, requestId, sql, database } = (data || {}) as {
    type?: string;
    requestId?: string;
    sql?: string;
    database?: string;
  };
  if (type !== 'system2:query') return;
  if (!requestId || !sql) return;

  try {
    const res = await fetchFn('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, ...(database ? { database } : {}) }),
    });
    const result = await res.json();
    if (!res.ok) {
      postMessage(
        { type: 'system2:query_error', requestId, error: result.error || 'Query failed' },
        '*'
      );
    } else {
      postMessage({ type: 'system2:query_result', requestId, ...result }, '*');
    }
  } catch (err) {
    postMessage({ type: 'system2:query_error', requestId, error: (err as Error).message }, '*');
  }
}
