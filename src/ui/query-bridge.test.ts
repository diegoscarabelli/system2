import { describe, expect, it, vi } from 'vitest';
import { handleQueryMessage } from './query-bridge';

function mockFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('handleQueryMessage', () => {
  it('ignores messages that are not system2:query', async () => {
    const postMessage = vi.fn();
    await handleQueryMessage({ type: 'other' }, postMessage, mockFetch({}));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores undefined data', async () => {
    const postMessage = vi.fn();
    await handleQueryMessage(undefined, postMessage, mockFetch({}));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends flattened rows and count in success response', async () => {
    const postMessage = vi.fn();
    const rows = [{ id: 1 }, { id: 2 }];
    const fetchFn = mockFetch({ rows, count: 2 });

    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'SELECT 1', database: 'lens' },
      postMessage,
      fetchFn
    );

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'system2:query_result', requestId: 'req-1', rows, count: 2 },
      '*'
    );
  });

  it('echoes requestId back in the response', async () => {
    const postMessage = vi.fn();
    await handleQueryMessage(
      { type: 'system2:query', requestId: 'abc-123', sql: 'SELECT 1' },
      postMessage,
      mockFetch({ rows: [], count: 0 })
    );

    const msg = postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.requestId).toBe('abc-123');
  });

  it('omits database from fetch body when not provided', async () => {
    const postMessage = vi.fn();
    const fetchFn = mockFetch({ rows: [], count: 0 });

    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'SELECT 1' },
      postMessage,
      fetchFn
    );

    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toEqual({ sql: 'SELECT 1' });
    expect(body.database).toBeUndefined();
  });

  it('includes database in fetch body when provided', async () => {
    const postMessage = vi.fn();
    const fetchFn = mockFetch({ rows: [], count: 0 });

    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'SELECT 1', database: 'analytics' },
      postMessage,
      fetchFn
    );

    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toEqual({ sql: 'SELECT 1', database: 'analytics' });
  });

  it('sends query_error on fetch failure', async () => {
    const postMessage = vi.fn();
    const fetchFn = vi.fn(async () => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'SELECT 1' },
      postMessage,
      fetchFn
    );

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'system2:query_error', requestId: 'req-1', error: 'Network error' },
      '*'
    );
  });

  it('routes HTTP error responses to query_error', async () => {
    const postMessage = vi.fn();
    const fetchFn = mockFetch({ error: 'Only SELECT and EXPLAIN queries are allowed' }, false);

    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'DROP TABLE foo' },
      postMessage,
      fetchFn
    );

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'system2:query_error',
        requestId: 'req-1',
        error: 'Only SELECT and EXPLAIN queries are allowed',
      },
      '*'
    );
  });

  it('falls back to generic message when HTTP error has no error field', async () => {
    const postMessage = vi.fn();
    const fetchFn = mockFetch({}, false);

    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'SELECT 1' },
      postMessage,
      fetchFn
    );

    const msg = postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe('system2:query_error');
    expect(msg.error).toBe('Query failed');
  });

  it('does not nest rows under a data property', async () => {
    const postMessage = vi.fn();
    await handleQueryMessage(
      { type: 'system2:query', requestId: 'req-1', sql: 'SELECT 1' },
      postMessage,
      mockFetch({ rows: [{ x: 1 }], count: 1 })
    );

    const msg = postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.rows).toEqual([{ x: 1 }]);
    expect(msg).not.toHaveProperty('data');
  });
});
