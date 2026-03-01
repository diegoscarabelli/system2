/**
 * App Component
 *
 * Root application component with Primer theme provider.
 */

import { ThemeProvider, BaseStyles } from '@primer/react';
import { Layout } from './components/Layout';
import { useThemeStore } from './stores/theme';

export function App() {
  const { colorMode } = useThemeStore();

  return (
    <ThemeProvider colorMode={colorMode === 'dark' ? 'night' : 'day'}>
      <BaseStyles>
        <Layout />
      </BaseStyles>
    </ThemeProvider>
  );
}
