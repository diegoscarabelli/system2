import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePushFetch } from './usePushFetch';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  } as Response);
}

function mockFetchFail(status: number, statusText: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
  } as Response);
}

describe('usePushFetch', () => {
  it('starts in loading state', () => {
    mockFetchOk({ items: [] });
    const onData = vi.fn();
    const { result } = renderHook(() => usePushFetch('/api/test', 0, onData));
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('calls onData and clears loading on success', async () => {
    const payload = { items: [1, 2, 3] };
    mockFetchOk(payload);
    const onData = vi.fn();
    const { result } = renderHook(() => usePushFetch('/api/test', 0, onData));

    // Wait for fetch to resolve
    await act(() => Promise.resolve());

    expect(onData).toHaveBeenCalledWith(payload);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets error on non-OK response', async () => {
    mockFetchFail(500, 'Internal Server Error');
    const onData = vi.fn();
    const { result } = renderHook(() => usePushFetch('/api/test', 0, onData));

    await act(() => Promise.resolve());

    expect(onData).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('500 Internal Server Error');
  });

  it('clears error on successful retry', async () => {
    const spy = mockFetchFail(503, 'Service Unavailable');
    const onData = vi.fn();
    const { result } = renderHook(() => usePushFetch('/api/test', 0, onData));

    await act(() => Promise.resolve());
    expect(result.current.error).toBe('503 Service Unavailable');

    // Fix the server and retry
    spy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(() => {
      result.current.retry();
    });
    await act(() => Promise.resolve());

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(onData).toHaveBeenCalledWith({ ok: true });
  });

  it('refetches when version changes', async () => {
    const spy = mockFetchOk({ v: 1 });
    const onData = vi.fn();
    const { result, rerender } = renderHook(
      ({ version }) => usePushFetch('/api/test', version, onData),
      { initialProps: { version: 0 } }
    );

    await act(() => Promise.resolve());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);

    spy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ v: 2 }),
    } as Response);

    rerender({ version: 1 });
    await act(() => Promise.resolve());

    expect(spy).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenLastCalledWith({ v: 2 });
  });

  it('resets error and loading when URL changes', async () => {
    mockFetchFail(404, 'Not Found');
    const onData = vi.fn();
    const { result, rerender } = renderHook(({ url }) => usePushFetch(url, 0, onData), {
      initialProps: { url: '/api/old' },
    });

    await act(() => Promise.resolve());
    expect(result.current.error).toBe('404 Not Found');

    // Change URL: should reset to loading with no error
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ fresh: true }),
    } as Response);

    rerender({ url: '/api/new' });
    // Synchronous reset happens before the fetch resolves
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    await act(() => Promise.resolve());
    expect(result.current.loading).toBe(false);
    expect(onData).toHaveBeenCalledWith({ fresh: true });
  });
});
