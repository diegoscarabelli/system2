import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from './init.js';

describe('system2 init', () => {
  let parentDir: string;
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'system2-init-test-'));
    dir = join(parentDir, '.system2');
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('creates the install directory and subdirectories on a fresh install', async () => {
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'sessions'))).toBe(true);
    expect(existsSync(join(dir, 'projects'))).toBe(true);
    expect(existsSync(join(dir, 'artifacts'))).toBe(true);
    expect(existsSync(join(dir, 'auth'))).toBe(true);
  });

  it('creates the auth/ directory at 0700 (POSIX)', async () => {
    if (process.platform === 'win32') return;
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    const mode = statSync(join(dir, 'auth')).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('does NOT create auth/.auth.toml — that is created by `system2 config` on first credential', async () => {
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    expect(existsSync(join(dir, 'auth', '.auth.toml'))).toBe(false);
  });

  it('writes a config.toml that holds only user-managed sections', async () => {
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('# System2 Configuration');
    // Auth-managed section headers must not appear as live TOML headers
    // (they live in .auth.toml). They may appear inside comment text — the
    // section labels are allowed to be referenced in informational comments.
    expect(content).not.toMatch(/^\[llm\./m);
    expect(content).not.toMatch(/^\[services\./m);
    expect(content).not.toMatch(/^\[tools\.web_search\]/m);
    // No commented stubs for auth-managed sections either (those are legacy).
    expect(content).not.toMatch(/^# \[llm\./m);
    expect(content).not.toMatch(/^# \[services\./m);
    // Header points the user at .auth.toml + system2 config.
    expect(content).toContain('.auth.toml');
    expect(content).toContain('system2 config');
  });

  it('chains into config() after creating the install', async () => {
    const invokeConfig = vi.fn(async () => {});
    await init({ system2Dir: dir, configFile: configPath, invokeConfig });
    expect(invokeConfig).toHaveBeenCalledOnce();
  });

  it('refuses to overwrite an existing config.toml (does not chain into config)', async () => {
    // Pre-create the install dir so init treats it as existing.
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    const invokeConfig = vi.fn(async () => {});
    await init({ system2Dir: dir, configFile: configPath, invokeConfig });
    expect(invokeConfig).not.toHaveBeenCalled();
  });

  it('does not clobber an existing .auth.toml on re-run (idempotent)', async () => {
    // First install + write a fake .auth.toml (simulating `system2 config`).
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    const authPath = join(dir, 'auth', '.auth.toml');
    const authContents = '# my creds\n[llm.oauth]\nprimary = "anthropic"\nfallback = []\n';
    writeFileSync(authPath, authContents);
    // Delete config.toml to trigger the recovery path on re-run.
    rmSync(configPath);
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    // .auth.toml survives untouched.
    expect(readFileSync(authPath, 'utf-8')).toBe(authContents);
  });
});
