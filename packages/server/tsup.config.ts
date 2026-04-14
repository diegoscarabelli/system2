import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
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
    // Copy shared agent reference to dist/agents/
    const srcAgents = join(__dirname, 'src', 'agents');
    const destAgents = join(__dirname, 'dist', 'agents');
    mkdirSync(destAgents, { recursive: true });
    copyFileSync(join(srcAgents, 'agents.md'), join(destAgents, 'agents.md'));
    console.log('✓ Copied agents.md to dist/');

    // Copy agent library .md files to dist/agents/library/
    const srcLibrary = join(srcAgents, 'library');
    const destLibrary = join(destAgents, 'library');

    mkdirSync(destLibrary, { recursive: true });

    const agentFiles = readdirSync(srcLibrary).filter((f) => f.endsWith('.md'));
    for (const file of agentFiles) {
      copyFileSync(join(srcLibrary, file), join(destLibrary, file));
    }

    console.log(`✓ Copied ${agentFiles.length} agent library file(s) to dist/`);

    // Copy built-in skill subdirectories to dist/agents/skills/
    // Each skill is a subdirectory containing SKILL.md (Agent Skills standard)
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
      console.log(`✓ Copied ${copied} skill(s) to dist/agents/skills/`);
    } else {
      console.log('✓ No built-in skills directory found, skipping');
    }

    // Copy schema.sql to dist/db/
    const srcDb = join(__dirname, 'src', 'db');
    const destDb = join(__dirname, 'dist', 'db');

    mkdirSync(destDb, { recursive: true });
    copyFileSync(join(srcDb, 'schema.sql'), join(destDb, 'schema.sql'));

    console.log('✓ Copied schema.sql to dist/');
  },
});
