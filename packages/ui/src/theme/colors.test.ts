import { describe, expect, it } from 'vitest';
import { colors, contextColor } from './colors';

describe('contextColor', () => {
  const accent = '#ffb444';

  it('returns teal below 50%', () => {
    expect(contextColor(0, accent)).toBe(colors.teal);
    expect(contextColor(49, accent)).toBe(colors.teal);
    expect(contextColor(49.9, accent)).toBe(colors.teal);
  });

  it('returns accent from 50% to 69%', () => {
    expect(contextColor(50, accent)).toBe(accent);
    expect(contextColor(60, accent)).toBe(accent);
    expect(contextColor(69.9, accent)).toBe(accent);
  });

  it('returns coral at 70% and above', () => {
    expect(contextColor(70, accent)).toBe(colors.coral);
    expect(contextColor(85, accent)).toBe(colors.coral);
    expect(contextColor(100, accent)).toBe(colors.coral);
  });
});
