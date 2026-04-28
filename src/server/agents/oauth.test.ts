import { describe, expect, it } from 'vitest';
import { isExpiringSoon } from './oauth.js';

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
