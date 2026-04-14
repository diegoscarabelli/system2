import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from './logger.js';

describe('log', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('log.info prepends an ISO timestamp', () => {
    log.info('[Server] started');
    expect(logSpy).toHaveBeenCalledOnce();
    const [timestamp, ...rest] = logSpy.mock.calls[0];
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rest).toEqual(['[Server] started']);
  });

  it('log.warn prepends an ISO timestamp', () => {
    log.warn('[Server] degraded');
    expect(warnSpy).toHaveBeenCalledOnce();
    const [timestamp, ...rest] = warnSpy.mock.calls[0];
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rest).toEqual(['[Server] degraded']);
  });

  it('log.error prepends an ISO timestamp', () => {
    const err = new Error('boom');
    log.error('[Server] fail:', err);
    expect(errorSpy).toHaveBeenCalledOnce();
    const [timestamp, ...rest] = errorSpy.mock.calls[0];
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rest).toEqual(['[Server] fail:', err]);
  });

  it('passes through multiple arguments', () => {
    log.info('a', 'b', 3, { key: 'val' });
    expect(logSpy).toHaveBeenCalledOnce();
    const [_timestamp, ...rest] = logSpy.mock.calls[0];
    expect(rest).toEqual(['a', 'b', 3, { key: 'val' }]);
  });
});
