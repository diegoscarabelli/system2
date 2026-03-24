import { describe, expect, it, vi } from 'vitest';
import { isNetworkAvailable } from './network.js';

vi.mock('node:dns/promises', () => ({
  resolve: vi.fn(),
}));

import { resolve } from 'node:dns/promises';

const mockResolve = vi.mocked(resolve);

describe('isNetworkAvailable', () => {
  it('returns true when DNS resolves successfully', async () => {
    mockResolve.mockResolvedValueOnce(['8.8.8.8'] as never);
    expect(await isNetworkAvailable()).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith('dns.google');
  });

  it('returns false when DNS resolution fails', async () => {
    mockResolve.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    expect(await isNetworkAvailable()).toBe(false);
  });

  it('returns false when DNS resolution exceeds timeout', async () => {
    mockResolve.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(['8.8.8.8'] as never), 5000))
    );
    expect(await isNetworkAvailable(50)).toBe(false);
  });

  it('respects custom timeout parameter', async () => {
    mockResolve.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(['8.8.8.8'] as never), 100))
    );
    // 200ms timeout should allow 100ms resolution to succeed
    expect(await isNetworkAvailable(200)).toBe(true);
  });
});
