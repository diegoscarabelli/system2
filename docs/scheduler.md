# Scheduler

System2 runs an in-process scheduler using [Croner](https://github.com/Hexagon/croner) for periodic Narrator jobs. Jobs pre-compute deterministic data and deliver it to the Narrator via `deliverMessage()`.

**Key source files:**
- `packages/server/src/scheduler/scheduler.ts`: Scheduler class
- `packages/server/src/scheduler/jobs.ts`: job definitions and data collection
- `packages/server/src/scheduler/network.ts`: network connectivity check

## Scheduler Class

Thin wrapper around Croner:

```typescript
class Scheduler {
  schedule(name: string, pattern: string, handler: () => void | Promise<void>): void
  stop(): void  // called during graceful shutdown
}
```

## Registered Jobs

| Job              | Schedule                       | Description                                                                |
|------------------|--------------------------------|----------------------------------------------------------------------------|
| `daily-summary`  | Every N minutes (default: 30)  | Collect activity, deliver project logs and daily summary to Narrator       |
| `memory-update`  | Daily at 11 AM                 | Embed daily summary content and send to Narrator for memory consolidation  |

The `daily-summary` interval is configurable via `[scheduler].daily_summary_interval_minutes` in config.toml.

## Network Guard

Each job checks network connectivity via a DNS lookup (`dns.google`) before executing. If the network is unreachable, the job is silently skipped and nothing is written to the Narrator's JSONL session. This prevents session bloat and context pollution when the laptop is sleeping (macOS Power Nap wakes the process periodically, but the network may not be available).

The check lives in each job handler, not in the Scheduler class, so future jobs can opt in or out individually. See `isNetworkAvailable()` in `packages/server/src/scheduler/network.ts`.

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
4. **Check for activity:** skip delivery if neither project activity (agent JSONL entries or DB changes) nor non-project activity is detected in the time window. Existing file content does not influence the skip decision: even if the file already has a narrative from an earlier run, a new delivery only happens when fresh activity arrives.
5. **Build message** with only the sections that have activity:
   - **Project Activity:** included only for projects that have agent JSONL entries or DB changes in the window; inactive projects are omitted entirely. The entire section is omitted when no project has changes.
   - **Non-Project Activity:** Guide JSONL (via `dailySummarySystemAgents`, which excludes Narrator to prevent recursive embedding of its own `custom_message` injections) and DB changes not tied to any active project. Omitted when there is no non-project activity.
6. **Deliver:** send to Narrator via `deliverMessage()` with `sender: 0` (system sentinel)

The Narrator synthesizes each section into narrative summaries, avoiding repetition of project-specific content already covered in project-log entries (which are processed first).

## Memory Update Pipeline

`buildAndDeliverMemoryUpdate()` runs daily at 11 AM:

1. Read `last_narrator_update_ts` from `memory.md`
2. List daily summary files since that date (lexicographic `>=` comparison, inclusive)
3. Read each file and embed its content inline in the message
4. Deliver to Narrator via `deliverMessage()` with all summary content included
5. Narrator incorporates summaries into `memory.md`, clears processed Notes

## Catch-Up on Startup

Croner does **not** catch up missed jobs after laptop sleep or server shutdown. The server handles this explicitly in `checkNarratorCatchUp()`:

1. **Network guard**: check `isNetworkAvailable()`. If the network is unreachable, skip all catch-up entirely.
2. **Daily summary**: resolve the last daily summary timestamp. If stale by more than `intervalMinutes`, queue `buildAndDeliverDailySummary()`
3. **Memory update**: read `last_narrator_update_ts` from `memory.md`. If stale by more than 24 hours, queue `buildAndDeliverMemoryUpdate()`

This runs once at server start, after agent sessions are initialized.

Both checks use `last_narrator_update_ts` as a cursor. This timestamp only advances when the Narrator successfully processes the delivered message and writes it back to the file's frontmatter. If a job is skipped (network down) or fails, the cursor stays stale and the next restart will re-trigger catch-up.

**Within a single server lifecycle:** if the server starts without network, catch-up is skipped entirely. The `daily-summary` job self-recovers within one cron interval (default 30 min) once the network is back, because its staleness check runs on every cron tick. The `memory-update` catch-up is lost until its next scheduled run (daily at 11 AM), since the cron handler only fires once per day. A server restart recovers both.

## See Also

- [Knowledge System](knowledge-system.md): files that the Narrator updates
- [Agents](agents.md): `deliverMessage()` and delivery modes
- [Configuration](configuration.md): `daily_summary_interval_minutes`
- [Server](packages/server.md): catch-up logic in `start()`
