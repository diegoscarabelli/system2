import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates, fetchLatestVersion, isNewer } from './update-notifier.js';

const SYSTEM2_DIR = join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.system2');
const CACHE_FILE = join(SYSTEM2_DIR, 'update-check.json');

let cacheBackup: string | undefined;

beforeEach(() => {
  if (existsSync(CACHE_FILE)) {
    cacheBackup = readFileSync(CACHE_FILE, 'utf-8');
  }
});

afterEach(() => {
  // Restore original cache
  if (cacheBackup !== undefined) {
    writeFileSync(CACHE_FILE, cacheBackup, 'utf-8');
    cacheBackup = undefined;
  } else if (existsSync(CACHE_FILE)) {
    unlinkSync(CACHE_FILE);
  }
});

describe('isNewer', () => {
  it('detects newer major version', () => {
    expect(isNewer('0.1.0', '1.0.0')).toBe(true);
  });

  it('detects newer minor version', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(true);
  });

  it('detects newer patch version', () => {
    expect(isNewer('0.1.0', '0.1.1')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewer('0.1.2', '0.1.2')).toBe(false);
  });

  it('returns false for older version', () => {
    expect(isNewer('1.0.0', '0.9.9')).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  it('returns version from registry response', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.0.0' }),
    })) as unknown as typeof fetch;

    const version = await fetchLatestVersion(fakeFetch);
    expect(version).toBe('2.0.0');
  });

  it('returns undefined on HTTP error', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    expect(await fetchLatestVersion(fakeFetch)).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await fetchLatestVersion(fakeFetch)).toBeUndefined();
  });
});

describe('checkForUpdates', () => {
  it('prints notice when cache has a newer version', () => {
    writeFileSync(CACHE_FILE, JSON.stringify({ lastCheck: Date.now(), latestVersion: '9.9.9' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '9.9.9' }),
    })) as unknown as typeof fetch;

    checkForUpdates('0.1.0', fakeFetch);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('Update available');
    expect(spy.mock.calls[0][0]).toContain('9.9.9');
    spy.mockRestore();
  });

  it('prints nothing when cache version matches current', () => {
    writeFileSync(CACHE_FILE, JSON.stringify({ lastCheck: Date.now(), latestVersion: '0.1.2' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '0.1.2' }),
    })) as unknown as typeof fetch;

    checkForUpdates('0.1.2', fakeFetch);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('prints nothing when no cache exists', () => {
    if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '0.1.0' }),
    })) as unknown as typeof fetch;

    checkForUpdates('0.1.0', fakeFetch);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('triggers background refresh when cache is stale', async () => {
    writeFileSync(CACHE_FILE, JSON.stringify({ lastCheck: 0, latestVersion: '0.1.0' }));
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '0.2.0' }),
    })) as unknown as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    checkForUpdates('0.1.0', fakeFetch);

    // Wait for background fetch and cache write to complete
    await vi.waitFor(() => {
      const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      expect(cache.latestVersion).toBe('0.2.0');
    });
    spy.mockRestore();
  });
});
