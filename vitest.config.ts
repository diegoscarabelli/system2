import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root: 'packages/server',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'cli',
          root: 'packages/cli',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          root: 'packages/ui',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/test-setup.ts'],
        },
      },
    ],
  },
});
