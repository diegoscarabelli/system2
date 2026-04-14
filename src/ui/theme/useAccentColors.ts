/**
 * Theme-aware accent colors hook.
 *
 * Returns the semantic palette for the current theme:
 *   Dark  → amber accent, magenta highlight
 *   Light → coral accent, purple highlight
 */

import { useThemeStore } from '../stores/theme';
import { palettes, type ThemePalette } from './colors';

export function useAccentColors(): ThemePalette {
  const colorMode = useThemeStore((s) => s.colorMode);
  return palettes[colorMode];
}
