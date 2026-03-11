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
  magenta: '#fd2ef5',
  gray: '#8b949e',
  deepTeal: '#066a7c',
  coral: '#ec4a2c',
  coralHover: '#d4432a',
  purple: '#b61899',
  purpleLight: '#c756ad',
  neutral: '#424242',
  critical: '#f85149',
} as const;

/**
 * Semantic palette — colors that change between light and dark themes.
 *
 * Dark  → amber accent, magenta highlight
 * Light → coral accent, purple highlight
 */
export interface ThemePalette {
  /** Primary accent (buttons, labels, dots, active indicators) */
  accent: string;
  accentHover: string;
  /** Subtle accent for tag backgrounds etc. (hex with alpha) */
  accentSubtle: string;
  /** Secondary highlight (tool calls, code actions) */
  highlight: string;
}

export const palettes = {
  dark: {
    accent: colors.amber,
    accentHover: colors.amberHover,
    accentSubtle: `${colors.amber}22`,
    highlight: colors.magenta,
  },
  light: {
    accent: colors.coral,
    accentHover: colors.coralHover,
    accentSubtle: `${colors.coral}22`,
    highlight: colors.purple,
  },
} as const satisfies Record<string, ThemePalette>;
