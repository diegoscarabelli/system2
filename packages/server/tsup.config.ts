import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Externalize native modules and pi-coding-agent (has CJS dependencies)
  external: [
    'better-sqlite3',
    '@mariozechner/pi-coding-agent',
    '@mariozechner/pi-agent-core',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-tui',
  ],
  onSuccess: async () => {
    // Copy agent library .md files to dist
    const srcLibrary = join(__dirname, 'src', 'agents', 'library');
    const destLibrary = join(__dirname, 'dist', 'agents', 'library');

    mkdirSync(destLibrary, { recursive: true });

    const agentFiles = ['guide.md', 'conductor.md', 'narrator.md', 'rigor-checker.md'];
    for (const file of agentFiles) {
      copyFileSync(join(srcLibrary, file), join(destLibrary, file));
    }

    console.log('✓ Copied agent library files to dist/');

    // Copy schema.sql to dist/db/
    const srcDb = join(__dirname, 'src', 'db');
    const destDb = join(__dirname, 'dist', 'db');

    mkdirSync(destDb, { recursive: true });
    copyFileSync(join(srcDb, 'schema.sql'), join(destDb, 'schema.sql'));

    console.log('✓ Copied schema.sql to dist/');
  },
});
