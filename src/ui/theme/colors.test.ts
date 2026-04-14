import { describe, expect, it } from 'vitest';
import { colors, contextColor } from './colors';

describe('contextColor', () => {
  const accent = '#ffb444';

  it('returns teal below 40%', () => {
    expect(contextColor(0, accent)).toBe(colors.teal);
    expect(contextColor(39, accent)).toBe(colors.teal);
    expect(contextColor(39.9, accent)).toBe(colors.teal);
  });

  it('returns accent from 40% to 49%', () => {
    expect(contextColor(40, accent)).toBe(accent);
    expect(contextColor(45, accent)).toBe(accent);
    expect(contextColor(49.9, accent)).toBe(accent);
  });

  it('returns coral at 50% and above', () => {
    expect(contextColor(50, accent)).toBe(colors.coral);
    expect(contextColor(75, accent)).toBe(colors.coral);
    expect(contextColor(100, accent)).toBe(colors.coral);
  });
});
