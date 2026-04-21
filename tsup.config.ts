import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'server/index': 'src/server/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  external: [
    'better-sqlite3',
    '@mariozechner/pi-coding-agent',
    '@mariozechner/pi-agent-core',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-tui',
  ],
  async onSuccess() {
    // Copy agent .md files
    const srcAgents = join(__dirname, 'src', 'server', 'agents');
    const destAgents = join(__dirname, 'dist', 'server', 'agents');
    mkdirSync(destAgents, { recursive: true });
    copyFileSync(join(srcAgents, 'agents.md'), join(destAgents, 'agents.md'));
    console.log('✓ Copied agents.md to dist/');

    // Copy agent library .md files
    const srcLibrary = join(srcAgents, 'library');
    const destLibrary = join(destAgents, 'library');
    mkdirSync(destLibrary, { recursive: true });

    const agentFiles = readdirSync(srcLibrary).filter((f) => f.endsWith('.md'));
    for (const file of agentFiles) {
      copyFileSync(join(srcLibrary, file), join(destLibrary, file));
    }
    console.log(`✓ Copied ${agentFiles.length} agent library file(s) to dist/`);

    // Copy built-in skills
    const srcSkills = join(srcAgents, 'skills');
    const destSkills = join(destAgents, 'skills');
    mkdirSync(destSkills, { recursive: true });
    if (existsSync(srcSkills)) {
      const entries = readdirSync(srcSkills);
      let copied = 0;
      for (const entry of entries) {
        const entryPath = join(srcSkills, entry);
        if (statSync(entryPath).isDirectory() && existsSync(join(entryPath, 'SKILL.md'))) {
          cpSync(entryPath, join(destSkills, entry), { recursive: true });
          copied++;
        }
      }
      console.log(`✓ Copied ${copied} skill(s) to dist/server/agents/skills/`);
    }

    // Copy schema.sql
    const srcDb = join(__dirname, 'src', 'server', 'db');
    const destDb = join(__dirname, 'dist', 'server', 'db');
    mkdirSync(destDb, { recursive: true });
    copyFileSync(join(srcDb, 'schema.sql'), join(destDb, 'schema.sql'));
    console.log('✓ Copied schema.sql to dist/');
  },
});
