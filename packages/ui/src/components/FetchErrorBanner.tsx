/**
 * Inline error banner shown when a push-triggered panel fetch fails.
 * Displays the error message and a retry button. Auto-cleared by the
 * parent when the next fetch succeeds.
 */

import { Box, Text } from '@primer/react';
import { colors } from '../theme/colors';

export function FetchErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Box
      role="alert"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        py: 1,
        backgroundColor: `${colors.coral}15`,
        borderBottom: '1px solid',
        borderColor: `${colors.coral}40`,
        fontSize: 0,
        flexShrink: 0,
      }}
    >
      <Text sx={{ color: colors.coral, flex: 1 }}>Failed to load data: {message}</Text>
      <Box
        as="button"
        type="button"
        onClick={onRetry}
        sx={{
          background: 'none',
          border: '1px solid',
          borderColor: `${colors.coral}60`,
          borderRadius: 1,
          color: colors.coral,
          cursor: 'pointer',
          fontSize: 0,
          px: 2,
          py: '2px',
          flexShrink: 0,
          '&:hover': { backgroundColor: `${colors.coral}20` },
          '&:focus-visible': { outline: '2px solid', outlineColor: colors.coral },
        }}
      >
        Retry
      </Box>
    </Box>
  );
}
