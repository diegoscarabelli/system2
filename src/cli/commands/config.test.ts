import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config.js';

// Mock the interactive primitives so we can drive the menu deterministically.
vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
  return {
    ...actual,
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    spinner: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

describe('system2 config (main menu navigation)', () => {
  let dir: string;
  let configPath: string;
  let authPath: string;
  // Spy is created per-suite and restored on teardown so the override doesn't
  // leak into other test files in the same Vitest run (other tests that call
  // process.exit would otherwise throw).
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    dir = mkdtempSync(join(tmpdir(), 'system2-config-test-'));
    configPath = join(dir, 'config.toml');
    // config.toml exists but is empty (no operational overrides); the install
    // marker `system2 config` checks for is just configPath existence.
    writeFileSync(configPath, '');
    mkdirSync(join(dir, 'auth'), { mode: 0o700 });
    authPath = join(dir, 'auth', 'auth.toml');
    // Seed auth.toml with an OAuth tier so `system2 config` doesn't think
    // the install is brand new (some tests assume the menu is operational).
    writeFileSync(authPath, `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n`);
    vi.mocked(p.select).mockReset();
    vi.mocked(p.confirm).mockReset();
    vi.mocked(p.password).mockReset();
    vi.mocked(p.text).mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it('exits when the user picks "Done" on the main menu', async () => {
    vi.mocked(p.select).mockResolvedValueOnce('done');
    await expect(config({ configFile: configPath, system2Dir: dir })).rejects.toThrow(
      /process.exit called/
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('returns to main menu after a submenu finishes (then exits on second "Done")', async () => {
    // First p.select: enter Services submenu. Second: pick __back__. Third: Done.
    vi.mocked(p.select)
      .mockResolvedValueOnce('services') // main menu
      .mockResolvedValueOnce('__back__') // services submenu
      .mockResolvedValueOnce('done'); // main menu again
    await expect(config({ configFile: configPath, system2Dir: dir })).rejects.toThrow(
      /process.exit called/
    );
    expect(p.select).toHaveBeenCalledTimes(3);
  });

  it('Brave Search: configures key when previously absent', async () => {
    vi.mocked(p.select)
      .mockResolvedValueOnce('services') // main menu
      .mockResolvedValueOnce('brave') // services submenu
      .mockResolvedValueOnce('__back__') // back to main menu
      .mockResolvedValueOnce('done'); // main menu again
    vi.mocked(p.password).mockResolvedValueOnce('BSK-test-1' as unknown as symbol);
    await expect(config({ configFile: configPath, system2Dir: dir })).rejects.toThrow(
      /process.exit called/
    );
    // 0.3.0 split: brave_search + tools.web_search live in auth.toml, not config.toml.
    const parsed = TOML.parse(readFileSync(authPath, 'utf-8')) as {
      services?: { brave_search?: { key?: string } };
      tools?: { web_search?: { enabled?: boolean } };
    };
    expect(parsed.services?.brave_search?.key).toBe('BSK-test-1');
    expect(parsed.tools?.web_search?.enabled).toBe(true);
  });

  it('Brave Search: empty input returns to services submenu (no write, no global exit)', async () => {
    vi.mocked(p.select)
      .mockResolvedValueOnce('services') // main menu
      .mockResolvedValueOnce('brave') // services submenu
      .mockResolvedValueOnce('__back__') // back to main menu
      .mockResolvedValueOnce('done'); // main menu again
    vi.mocked(p.password).mockResolvedValueOnce('' as unknown as symbol);
    const beforeAuth = readFileSync(authPath, 'utf-8');
    await expect(config({ configFile: configPath, system2Dir: dir })).rejects.toThrow(
      /process.exit called/
    );
    expect(readFileSync(authPath, 'utf-8')).toBe(beforeAuth);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
