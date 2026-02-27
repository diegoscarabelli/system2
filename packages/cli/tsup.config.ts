import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  external: [
    'readline/promises',
    'fs/promises',
    'path',
    'os',
    'process',
    'url',
    'better-sqlite3',
  ],
});
