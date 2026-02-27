/**
 * App Component
 *
 * Root application component with Primer theme provider.
 */

import { ThemeProvider, BaseStyles } from '@primer/react';
import { Chat } from './components/Chat';

export function App() {
  return (
    <ThemeProvider>
      <BaseStyles>
        <Chat />
      </BaseStyles>
    </ThemeProvider>
  );
}
