import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  external: [
    'fs/promises',
    'path',
    'os',
    'process',
    'url',
    'better-sqlite3',
    // Gateway dependencies with CJS code
    '@system2/gateway',
    '@mariozechner/pi-coding-agent',
    '@mariozechner/pi-agent-core',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-tui',
  ],
  async onSuccess() {
    // Copy config.toml template to dist
    const configDir = join(__dirname, 'dist', 'config');
    mkdirSync(configDir, { recursive: true });
    copyFileSync(
      join(__dirname, 'src', 'config', 'config.toml'),
      join(configDir, 'config.toml')
    );
    console.log('✓ Copied config.toml template to dist/');
  },
});
