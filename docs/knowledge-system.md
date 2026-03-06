# Knowledge System

System2 maintains persistent knowledge in `~/.system2/knowledge/`, git-tracked for change history. Knowledge files are injected into agent system prompts dynamically -- re-read on every LLM API call for immediate effect.

**Key source files:**
- `packages/server/src/knowledge/init.ts` -- directory initialization
- `packages/server/src/knowledge/templates.ts` -- default file templates
- `packages/server/src/knowledge/git.ts` -- git repo setup
- `packages/server/src/agents/host.ts` -- `loadKnowledgeContext()` method

## Knowledge Directory

```
~/.system2/knowledge/
├── infrastructure.md      # Data stack details (databases, orchestrator, repos)
├── user.md                # User profile and preferences
├── memory.md              # Long-term memory with YAML frontmatter
└── daily_summaries/       # Daily activity summaries
    ├── 2024-01-15.md
    ├── 2024-01-16.md
    └── ...
```

## File Ownership

| File | Written By | Updated When |
|------|-----------|-------------|
| `infrastructure.md` | Guide | During onboarding and as infrastructure evolves |
| `user.md` | Guide | During onboarding and ongoing interactions |
| `memory.md` | Narrator | Daily at 4 AM (memory-update job) |
| `memory.md ## Notes` | Any agent | Anytime -- agents write important facts here |
| `daily_summaries/*.md` | Narrator | Every 30 minutes (configurable) |

## How Knowledge Enters System Prompts

`AgentHost.loadKnowledgeContext()` runs on every LLM call (via `systemPromptOverride` callback):

1. Reads `infrastructure.md`, `user.md`, `memory.md`
2. Skips files with 10 or fewer lines (empty templates)
3. Reads the 2 most recent daily summary files (sorted by filename, chronological order)
4. Returns all content under a `## Knowledge Base` header, separated by `---`

This is appended to the static system prompt (agents.md + role instructions).

## memory.md

Long-term memory maintained by the Narrator. Has YAML frontmatter tracking timestamps:

```markdown
---
last_narrator_update_ts: 2024-01-16T04:00:00.000Z
---
# Memory

Consolidated knowledge about the system, user, and project history.

## Notes

Agents write important facts here for the Narrator to incorporate.
```

The **## Notes** section is a scratchpad -- any agent can append notes. During the daily memory-update job (4 AM), the Narrator reads all recent daily summaries, incorporates new information into the memory document, and clears processed notes.

## Daily Summaries

Append-only files named `YYYY-MM-DD.md` with YAML frontmatter:

```markdown
---
last_narrator_update_ts: 2024-01-16T15:30:00.000Z
---
# Daily Summary — 2024-01-16

Narrative content appended by the Narrator every 30 minutes...
```

The scheduler pre-computes all activity data (JSONL session records, database changes) and sends it to the Narrator, which synthesizes narrative summaries. See [Scheduler](scheduler.md) for the pipeline details.

## Git Tracking

`~/.system2/` is initialized as a git repository (`knowledge/git.ts`). The Narrator commits after updating knowledge files, providing change history. Binary and runtime files (`.db`, `.jsonl`, `.pid`, `.log`, `node_modules/`) are gitignored.

## Initialization

`initializeKnowledge()` creates the knowledge directory structure and writes template files if they don't exist. This is idempotent -- called on every server start.

## See Also

- [Agents](agents.md) -- system prompt construction using knowledge
- [Scheduler](scheduler.md) -- jobs that trigger Narrator updates
- [Configuration](configuration.md) -- `daily_summary_interval_minutes` setting
