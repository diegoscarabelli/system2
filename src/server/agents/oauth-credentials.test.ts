import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOAuthCredentials, saveOAuthCredentials } from './oauth-credentials.js';

describe('oauth-credentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-oauth-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when credentials file does not exist', () => {
    expect(loadOAuthCredentials(dir, 'anthropic')).toBeNull();
  });

  it('round-trips credentials per provider', () => {
    const creds = {
      access: 'sk-ant-oat-abc',
      refresh: 'rt-xyz',
      expires: 1714680000000,
      label: 'claude-pro',
    };
    saveOAuthCredentials(dir, 'anthropic', creds);
    expect(loadOAuthCredentials(dir, 'anthropic')).toEqual(creds);
    expect(loadOAuthCredentials(dir, 'openai')).toBeNull();
  });

  it('writes file with mode 0600', () => {
    saveOAuthCredentials(dir, 'anthropic', { access: 'a', refresh: 'b', expires: 1, label: 'l' });
    const stats = statSync(join(dir, 'oauth', 'anthropic.json'));

    if (process.platform === 'win32') {
      // POSIX mode bits aren't reliably supported on Windows
      expect(stats.isFile()).toBe(true);
      return;
    }

    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('enforces 0700 on the oauth directory', async () => {
    const { mkdirSync, statSync } = await import('node:fs');
    // Pre-create the directory with a looser mode
    mkdirSync(join(dir, 'oauth'), { recursive: true, mode: 0o755 });
    saveOAuthCredentials(dir, 'anthropic', { access: 'a', refresh: 'b', expires: 1, label: 'l' });
    if (process.platform === 'win32') {
      expect(statSync(join(dir, 'oauth')).isDirectory()).toBe(true);
      return;
    }
    const mode = statSync(join(dir, 'oauth')).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('returns null when file is corrupt JSON', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'oauth'), { recursive: true });
    writeFileSync(join(dir, 'oauth', 'anthropic.json'), '{not json');
    expect(loadOAuthCredentials(dir, 'anthropic')).toBeNull();
  });

  it('returns null when file is missing required fields', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'oauth'), { recursive: true });
    writeFileSync(join(dir, 'oauth', 'anthropic.json'), JSON.stringify({ access: 'a' }));
    expect(loadOAuthCredentials(dir, 'anthropic')).toBeNull();
  });
});
