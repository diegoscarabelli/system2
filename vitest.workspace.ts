import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
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
]);
