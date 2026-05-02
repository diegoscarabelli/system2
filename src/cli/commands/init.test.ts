import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  });

  it('writes a templated (commented) config.toml', async () => {
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    // Should contain section dividers but no live primary= line for either tier.
    expect(content).toContain('# System2 Configuration');
    expect(content).toMatch(/# \[llm\.api_keys\]|# \[llm\.oauth\]/);
    expect(content).not.toMatch(/^primary = /m);
  });

  it('chains into config() after creating the install', async () => {
    const invokeConfig = vi.fn(async () => {});
    await init({ system2Dir: dir, configFile: configPath, invokeConfig });
    expect(invokeConfig).toHaveBeenCalledOnce();
  });

  it('refuses to overwrite an existing install (does not chain into config)', async () => {
    // Pre-create the install dir so init treats it as existing.
    await init({ system2Dir: dir, configFile: configPath, invokeConfig: vi.fn() });
    const invokeConfig = vi.fn(async () => {});
    await init({ system2Dir: dir, configFile: configPath, invokeConfig });
    expect(invokeConfig).not.toHaveBeenCalled();
  });
});
