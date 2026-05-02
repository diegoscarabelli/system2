import { getOAuthProvider } from '@mariozechner/pi-ai/oauth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isExpiringSoon, loginProvider, refreshOAuthToken } from './oauth.js';

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  getOAuthProvider: vi.fn(),
}));

const mockedGetOAuthProvider = vi.mocked(getOAuthProvider);

describe('isExpiringSoon', () => {
  it('returns true when expires is within buffer', () => {
    expect(isExpiringSoon(Date.now() + 60_000, 5 * 60_000)).toBe(true);
  });

  it('returns false when expires is well in the future', () => {
    expect(isExpiringSoon(Date.now() + 60 * 60_000, 5 * 60_000)).toBe(false);
  });

  it('returns true when already expired', () => {
    expect(isExpiringSoon(Date.now() - 1000, 5 * 60_000)).toBe(true);
  });

  it('uses default buffer when not provided', () => {
    expect(isExpiringSoon(Date.now() + 60_000)).toBe(true);
    expect(isExpiringSoon(Date.now() + 60 * 60_000)).toBe(false);
  });
});

describe('oauth dispatcher', () => {
  beforeEach(() => {
    mockedGetOAuthProvider.mockReset();
  });

  it('loginProvider dispatches to pi-ai getOAuthProvider', async () => {
    const mockLogin = vi.fn().mockResolvedValue({
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 3600_000,
    });
    mockedGetOAuthProvider.mockReturnValue({
      id: 'openai-codex',
      name: 'OpenAI Codex',
      login: mockLogin,
      refreshToken: vi.fn(),
      getApiKey: () => '',
    } as unknown as ReturnType<typeof getOAuthProvider>);
    const callbacks = {
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    };
    await loginProvider('openai-codex', callbacks);
    expect(mockedGetOAuthProvider).toHaveBeenCalledWith('openai-codex');
    expect(mockLogin).toHaveBeenCalledWith(callbacks);
  });

  it('refreshOAuthToken dispatches with full credential preserving extras', async () => {
    const cred = {
      access: 'old',
      refresh: 'r',
      expires: Date.now() - 1000,
      label: 'main',
    };
    const refreshed = { ...cred, access: 'new', expires: Date.now() + 3600_000 };
    const mockRefresh = vi.fn().mockResolvedValue(refreshed);
    mockedGetOAuthProvider.mockReturnValue({
      id: 'anthropic',
      name: 'Anthropic',
      login: vi.fn(),
      refreshToken: mockRefresh,
      getApiKey: () => '',
    } as unknown as ReturnType<typeof getOAuthProvider>);
    const result = await refreshOAuthToken('anthropic', cred);
    expect(mockedGetOAuthProvider).toHaveBeenCalledWith('anthropic');
    expect(mockRefresh).toHaveBeenCalledWith(cred);
    expect(result.access).toBe('new');
    expect(result.label).toBe('main');
  });

  it('throws when pi-ai does not have a provider with the given id', async () => {
    mockedGetOAuthProvider.mockReturnValue(undefined);
    await expect(
      loginProvider('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() })
    ).rejects.toThrow(/not registered/i);
  });
});
