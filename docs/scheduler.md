# Scheduler

System2 runs an in-process scheduler using [Croner](https://github.com/Hexagon/croner) for periodic Narrator jobs. Jobs pre-compute deterministic data and deliver it to the Narrator via `deliverMessage()`.

**Key source files:**
- `packages/server/src/scheduler/scheduler.ts` -- Scheduler class
- `packages/server/src/scheduler/jobs.ts` -- job definitions and data collection

## Scheduler Class

Thin wrapper around Croner:

```typescript
class Scheduler {
  schedule(name: string, pattern: string, handler: () => void): void
  stop(): void  // called during graceful shutdown
}
```

## Registered Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `daily-summary` | Every N minutes (default: 30) | Collect activity and deliver to Narrator for summarization |
| `memory-update` | Daily at 4 AM | Send daily summaries list to Narrator for memory consolidation |

The `daily-summary` interval is configurable via `[scheduler].daily_summary_interval_minutes` in config.toml.

## Daily Summary Pipeline

`buildAndDeliverDailySummary()` runs on each trigger:

1. **Read previous context** -- last 20 lines of the most recent daily summary
2. **Create today's file** if it doesn't exist (with empty YAML frontmatter)
3. **Resolve `last_run_ts`** via fallback chain:
   - Today's daily summary frontmatter (`last_narrator_update_ts`)
   - Most recent daily summary frontmatter (by filename sort)
   - `memory.md` frontmatter
   - Fall back to `intervalMinutes` ago
4. **Collect agent activity** -- read JSONL session entries from all non-archived agents in the time window (`lastRunTs` to `newRunTs`). Only `message` and `custom_message` entry types are included.
5. **Collect database changes** -- query `task`, `project`, `task_comment`, `task_link` tables for rows updated/created in the time window. Format as markdown tables.
6. **Check for activity** -- skip delivery if there's no agent activity, no DB changes, and no previous context
7. **Build and deliver** -- assemble a markdown message with all data and send to Narrator via `deliverMessage()` with `sender: 0` (system sentinel)

The Narrator then synthesizes the data into a narrative summary and appends it to the daily summary file.

## Memory Update Pipeline

Runs daily at 4 AM:

1. Read `last_narrator_update_ts` from `memory.md`
2. List daily summary files since that date
3. Send file paths to Narrator via `deliverMessage()`
4. Narrator reads summaries, incorporates into `memory.md`, clears processed Notes

## Catch-Up on Startup

Croner does **not** catch up missed jobs after laptop sleep or server shutdown. The server handles this explicitly in `checkNarratorCatchUp()`:

1. Resolve the last daily summary timestamp
2. Calculate staleness (time since last run)
3. If stale by more than `intervalMinutes`, queue `buildAndDeliverDailySummary()`

This runs once at server start, after agent sessions are initialized.

## See Also

- [Knowledge System](knowledge-system.md) -- files that the Narrator updates
- [Agents](agents.md) -- `deliverMessage()` and delivery modes
- [Configuration](configuration.md) -- `daily_summary_interval_minutes`
- [Server](packages/server.md) -- catch-up logic in `start()`
