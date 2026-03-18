# Scheduler

System2 runs an in-process scheduler using [Croner](https://github.com/Hexagon/croner) for periodic Narrator jobs. Jobs pre-compute deterministic data and deliver it to the Narrator via `deliverMessage()`.

**Key source files:**
- `packages/server/src/scheduler/scheduler.ts`: Scheduler class
- `packages/server/src/scheduler/jobs.ts`: job definitions and data collection

## Scheduler Class

Thin wrapper around Croner:

```typescript
class Scheduler {
  schedule(name: string, pattern: string, handler: () => void): void
  stop(): void  // called during graceful shutdown
}
```

## Registered Jobs

| Job              | Schedule                       | Description                                                          |
|------------------|--------------------------------|----------------------------------------------------------------------|
| `daily-summary`  | Every N minutes (default: 30)  | Collect activity, deliver project logs and daily summary to Narrator |
| `memory-update`  | Daily at 11 AM                 | Send daily summaries list to Narrator for memory consolidation       |

The `daily-summary` interval is configurable via `[scheduler].daily_summary_interval_minutes` in config.toml.

## Daily Summary Pipeline

`buildAndDeliverDailySummary()` runs on each trigger in two phases: project logs first, then the daily summary.

### Phase 1: Project Logs

For each active project (those with a non-archived Conductor):

1. Ensure `~/.system2/projects/{id}_{name}/` directory exists
2. Create `log.md` with YAML frontmatter if it doesn't exist
3. Read most recent `log.md` content (last 10,000 characters via `readTailChars`)
4. Collect activity from all agents involved in the project (project-scoped agents + Guide; Narrator is excluded via `projectLogSystemAgents` to prevent recursive embedding). JSONL entries are stripped before injection: thinking blocks (type `thinking`) are dropped entirely; metadata fields `thoughtSignature`, `usage`, `api`, `provider`, `model`, and `details` are removed; tool call argument values and tool result content are truncated to 100 chars.
5. Collect project-scoped DB changes (task, project, task_comment, task_link records belonging to the project)
6. If there is activity, deliver a `[Scheduled task: project-log]` message to the Narrator

Each project log is a single continuous file per project lifetime (unlike daily summaries which create a new file per day).

### Phase 2: Daily Summary

1. **Create today's file** if it doesn't exist (with empty YAML frontmatter)
2. **Read current daily summary file content:** full content of today's daily summary file
3. **Resolve timestamps** via fallback chain:
   - Today's daily summary frontmatter (`last_narrator_update_ts`)
   - Most recent daily summary frontmatter (by filename sort)
   - `memory.md` frontmatter
   - Fall back to `intervalMinutes` ago
4. **Build message** with two sections:
   - **Project Activity:** per-project sections with project-scoped agent JSONL and project DB changes (reused from Phase 1)
   - **Non-Project Activity:** Guide JSONL (via `dailySummarySystemAgents`, which excludes Narrator to prevent recursive embedding of its own `custom_message` injections) and DB changes not tied to any active project.
5. **Check for activity:** skip delivery if there's no meaningful activity
6. **Deliver:** send to Narrator via `deliverMessage()` with `sender: 0` (system sentinel)

The Narrator synthesizes each section into narrative summaries, avoiding repetition of project-specific content already covered in project-log entries (which are processed first).

## Memory Update Pipeline

`buildAndDeliverMemoryUpdate()` runs daily at 11 AM:

1. Read `last_narrator_update_ts` from `memory.md`
2. List daily summary files since that date
3. Send file paths to Narrator via `deliverMessage()`
4. Narrator reads summaries, incorporates into `memory.md`, clears processed Notes

## Catch-Up on Startup

Croner does **not** catch up missed jobs after laptop sleep or server shutdown. The server handles this explicitly in `checkNarratorCatchUp()`:

1. **Daily summary**: resolve the last daily summary timestamp. If stale by more than `intervalMinutes`, queue `buildAndDeliverDailySummary()`
2. **Memory update**: read `last_narrator_update_ts` from `memory.md`. If stale by more than 24 hours, queue `buildAndDeliverMemoryUpdate()`

This runs once at server start, after agent sessions are initialized.

## See Also

- [Knowledge System](knowledge-system.md): files that the Narrator updates
- [Agents](agents.md): `deliverMessage()` and delivery modes
- [Configuration](configuration.md): `daily_summary_interval_minutes`
- [Server](packages/server.md): catch-up logic in `start()`
