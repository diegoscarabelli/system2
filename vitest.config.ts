import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          include: ['src/shared/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          include: ['src/server/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'cli',
          include: ['src/cli/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          include: ['src/ui/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/ui/test-setup.ts'],
        },
      },
    ],
  },
});
