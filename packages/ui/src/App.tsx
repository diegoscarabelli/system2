/**
 * App Component
 *
 * Root application component with Primer theme provider.
 */

import { BaseStyles, ThemeProvider, theme } from '@primer/react';
import { Layout } from './components/Layout';
import { useThemeStore } from './stores/theme';

const geistTheme = {
  ...theme,
  fonts: {
    ...theme.fonts,
    normal: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
    mono: '"Geist Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  },
};

export function App() {
  const { colorMode } = useThemeStore();

  return (
    <ThemeProvider theme={geistTheme} colorMode={colorMode === 'dark' ? 'night' : 'day'}>
      <BaseStyles>
        <Layout />
      </BaseStyles>
    </ThemeProvider>
  );
}
