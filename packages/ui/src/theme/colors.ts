/**
 * Color Palette
 *
 * Raw color definitions and theme-aware palettes for the System2 UI.
 */

/** Raw color values — use `palettes` for theme-aware access */
export const colors = {
  teal: '#00aaba',
  tealHover: '#009aa8',
  amber: '#ffb444',
  amberHover: '#e6a23c',
  coral: '#f15a2b',
  coralHover: '#d95126',
  gold: '#d97706',
  goldHover: '#c46b05',
  magenta: '#fd2ef5',
  purple: '#cb19aa',
  gray: '#8b949e',
} as const;

/**
 * Semantic palette — colors that change between light and dark themes.
 *
 * Dark  → amber accent, magenta highlight
 * Light → gold accent, purple highlight
 */
export interface ThemePalette {
  /** Primary accent (buttons, labels, dots, active indicators) */
  accent: string;
  accentHover: string;
  /** Subtle accent for tag backgrounds etc. (hex with alpha) */
  accentSubtle: string;
  /** Secondary highlight (tool calls, code actions) */
  highlight: string;
  /** Text color on top of accent background */
  accentText: string;
}

export const palettes = {
  dark: {
    accent: colors.amber,
    accentHover: colors.amberHover,
    accentSubtle: `${colors.amber}22`,
    highlight: colors.magenta,
    accentText: '#000',
  },
  light: {
    accent: colors.gold,
    accentHover: colors.goldHover,
    accentSubtle: `${colors.gold}22`,
    highlight: colors.purple,
    accentText: '#ffffff',
  },
} as const satisfies Record<string, ThemePalette>;

/** Map a context-usage percentage to a severity color. */
export function contextColor(percent: number, accent: string): string {
  if (percent >= 70) return colors.coral;
  if (percent >= 50) return accent;
  return colors.teal;
}
