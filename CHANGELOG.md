# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.8] - 2026-05-12

### Fixed

- `Scheduler.schedule()` now catches handler rejections at the cron→handler boundary, so a single bad scheduled tick no longer terminates the daemon. Croner does not catch handler errors by default (only when `options.catch` is set), so any rejection from the registered handler propagated up through the timer callback and surfaced as an unhandled promise rejection, which Node 25 treats as an uncaught exception (`triggerUncaughtException(err, true /* fromPromise */)`) and exits the process. That is exactly how the `daily-summary` cron took the server down on 2026-05-12 at 00:20 local: an Anthropic `overloaded_error` arrived mid-stream after the model had emitted output, `handlePotentialError` correctly aborted both pending deliveries (from #177 in 0.3.4), `buildAndDeliverDailySummary` threw the `AggregateError` introduced in 0.3.5, `trackJobExecution` recorded the failure and re-threw by design, and the cron handler had no catch around it. The 0.3.5 fix consolidated multiple floating rejections into one well-formed `AggregateError` but left that aggregate free to escape the handler; this completes the picture by wrapping every scheduled handler in a `safeHandler` that logs `[Scheduler] Job "<name>" handler error (uncaught):` and returns. Same protection that `server.ts` startup catch-up already uses (`:706-708`, `:740-742`); placing it inside `Scheduler.schedule` itself means current and future jobs inherit it without per-call boilerplate. The DB-level `job_execution.status='failed'` row from `trackJobExecution` is still written, so observability is unchanged — the daemon just keeps running and the next cron tick can recover. Fixes [#184](https://github.com/diegoscarabelli/system2/issues/184).

## [0.3.7] - 2026-05-12

### Fixed

- Session rotation now drops orphan `tool_result` entries (and their dependent descendants) before writing the new JSONL. Pi-ai's compaction can place its cut between a `tool_use` and its matching `tool_result` — the compaction marker's `firstKeptEntryId` records the cut faithfully, but the kept range ends up with a `tool_result` whose `tool_use` was summarized away. Without this filter, the SDK reconstructs an API request containing an orphan `tool_result` block, and every LLM provider rejects it (Anthropic: `unexpected tool_use_id found in tool_result blocks`; Google: `function response turn must come immediately after a function call turn`), locking the agent out of every failover lane. The fix adds a post-rotation `filterOrphanToolResults` pass that scans assembled entries, identifies `toolResult`s whose `toolCallId` isn't emitted by any kept assistant `toolCall` block, and drops them together with any entries whose `parentId` chains back to a dropped entry (so a dangling assistant text response chained to the orphan goes too). Applied in both the anchored-rotation path (where the bug actually originates) and `forceBareBytesTailRotation` (defense in depth — `selectTailEntries` already aligns to user-turn boundaries and shouldn't produce orphans, but the filter is cheap). The root cause is upstream in pi-ai; this is a system2-side defense so future occurrences degrade gracefully (drop a few stranded entries + log a warning) instead of bricking the agent.

## [0.3.6] - 2026-05-12

### Changed

- Replaced system2's custom `read` tool with pi-ai's `createReadTool` (from `@mariozechner/pi-coding-agent`, already a dependency). System2's previous `read.ts` was a thin wrapper around `fs.readFile` with no `offset` / `limit`, no size cap, and no truncation — meaning the bash output-cap pattern in this release was effectively bypassable by reading the saved file back into context. Pi-ai's `createReadTool` ships everything that pattern needs: `offset` (1-indexed line) + `limit` (line count) for slicing; per-call truncation at 2,000 lines or 50 KB with a `[Showing lines X-Y of N. Use offset=Z to continue.]` continuation hint; image auto-resize for vision-capable models; a `[Line N is X.XKB, exceeds 50.0KB limit. Use bash: sed -n 'Np' ...]` fallback when a single line exceeds the byte cap; AbortSignal support; and Unicode-normalization for macOS screenshot-style paths (NFD, U+2019 right-single-quotation-mark, leading `@`). Wired with `homedir()` as cwd to mirror the legacy semantics where relative paths resolved against the user's home directory. **Behavioral change on missing files**: the legacy system2 `read` returned a successful tool response with text `"File not found: <path>"`; pi-ai's `read` throws and the SDK turns the throw into a tool-error event. Same end result for the model (it sees "this tool failed") but the JSONL records differ — any log query grepping for the literal `File not found:` string would miss future errors. Closes #181. (See [docs/tools.md](docs/tools.md) for the new parameter table and recovery pattern.)
- `bash` tool now caps inline output at **128 KB** (configurable). When stdout + stderr exceeds the cap (measured in UTF-8 bytes via `Buffer.byteLength`, not UTF-16 code units — applies both to the inline cap and to the streaming-side `MAX_BUFFER` runaway-process guard, which now tracks running UTF-8 byte counts per chunk via `Buffer.byteLength(chunk, 'utf8')`), the full output is saved to `<sessionDir>/bash-output/<safeOutputFilename(toolCallId)>` and the response carries head (≤ 8 KB) + tail (≤ 2 KB) previews + the file path + total byte / line counts. Preview budgets clamp down to fit `maxInlineBytes` so a user-set override below the defaults can't push head + tail past the cap. A final-guard loop measures the rendered inline string's actual UTF-8 byte length and shrinks `head` (then `tail`) until it fits — handles long `savedPath` strings or locale-formatted count fields that would exceed the fixed 512-byte header reserve. The agent can read specific slices via the `read` tool (with `offset` / `limit`) or rerun bash with `grep`/`tail`/`sed` on the saved file. The persisted `details.stdout` / `details.stderr` are also shrunk to a short pointer marker when output was saved, so the JSONL session log doesn't re-store the same megabytes that already live in the saved file. Motivation: a single bash command that dumped a ~6.9 MB Python stack trace from a failed Prefect run blew the conductor's context from 51% → 86% in one tool result, then the next user message produced a 4.37 M-token prompt that Anthropic 400'd (`prompt is too long: 4374639 tokens > 1000000 maximum`). The cap policy mirrors Claude Code's `Bash` tool (30 KB default, configurable up to 150 KB) — proportionally scaled up for system2's 1 M-token context models. Default exposed via `bash_max_inline_output_bytes` in `config.toml` (top-level scalar, matching the `web_search_max_results` pattern); the CLI validator rejects non-integer, ≤ 0, or < 4 KB values with a warning and falls back to the default. The streaming-side hard cap `MAX_BUFFER` stays at 10 MB and continues to drop bytes beyond that as a runaway-process guard — the saved file holds whatever was captured up to that limit (i.e., it is NOT a guarantee against truncation for >10 MB streams).

## [0.3.5] - 2026-05-11

### Fixed

- Daily-summary cron no longer crashes the server when two or more narrator deliveries reject in the same tick. `buildAndDeliverDailySummary` has always awaited the deliveries array with `await Promise.all(...)`, which surfaces only the first rejection and leaves any others as floating rejected promises. The bug was latent until the contamination short-circuit in `handlePotentialError` (#177, in 0.3.4) started aborting **all** pending deliveries on a single mid-turn API failure: from that point, any daily-summary cron run with ≥2 deliveries that hit a mid-turn error promoted at least one rejection to `unhandledRejection` → uncaught exception → process exit on Node 25 (whose default behavior for unhandled rejections is `throw`). Replaced with `Promise.allSettled` + per-failure `log.error` + an `AggregateError` throw whose message flattens each delivery's label and error message so `job_execution.error` keeps the diagnostic detail (the raw `AggregateError.stack` only shows the aggregator's own frames). Each delivery is now tagged at push time (`project-log:<name>` or `daily-summary`) so the rejection log and the aggregate message identify exactly which payload failed. All-or-nothing semantics preserved: `advanceFrontmatterCursors` still runs only when every delivery succeeds, so the next cron tick retries from the same `lastRunTs`.

## [0.3.4] - 2026-05-11

### Changed

- The chat-store's `compactionStatus` no longer has a `'compacted'` terminal state. `finishCompaction` transitions `'compacting' → 'idle'` directly, so the transient in-flight indicator at the bottom of the timeline disappears as soon as the compaction completes (instead of staying glued at the bottom out of chronological order while later messages stream in above it). The persisted "Context compacted" system message from `history-capture` already records the event in correct chronological position ([#174](https://github.com/diegoscarabelli/system2/pull/174))

### Fixed

- Auto-compaction now runs end-to-end on high-context Anthropic models. The pi-coding-agent SDK was computing `maxTokens = 0.8 × reserveTokens` (or `0.5 ×` for turn-prefix summaries) without clamping at `model.maxTokens`, so on configurations where `0.25 × contextWindow > model.maxTokens` (in practice: `claude-opus-4-7` with the 1M-context variant and our `reserveTokens = 500K`) every summarization request was rejected by the API with HTTP 400 (`max_tokens: 250000 > 128000`). Context grew unbounded turn after turn while the chat falsely reported successful compactions. Fixed locally via `pnpm patch @mariozechner/pi-coding-agent@0.71.1` clamping at both call sites; the same fix was filed upstream as [pi-mono#4390](https://github.com/badlogic/pi-mono/issues/4390) ([#174](https://github.com/diegoscarabelli/system2/pull/174))
- `history-capture` now surfaces the real outcome of `compaction_end` instead of pushing a generic "Context compacted" for every event regardless of success. Successful compactions get a clean "Context compacted"; aborted ones get "Context compaction aborted"; failed ones include the SDK's `errorMessage`. This is the patch that exposed the SDK 400 above — without it the failure was invisible for ~10 days. Message IDs use `randomUUID()` (full UUID) instead of `msg-${Date.now()}` to prevent React key collisions when start/end fire within the same millisecond (which happens on silent-failure paths) ([#174](https://github.com/diegoscarabelli/system2/pull/174))
- `AgentHost.handleCompactionTracking` only bumps the pruning counter when the SDK reports a real success (`result != null && !aborted && !errorMessage`). Previously every `compaction_end` event incremented the counter, so silent failures inflated it toward `compaction_depth` and would have triggered a doomed pruning compaction (which would 400-fail for the same SDK reason). The parameter is now typed as `AgentSessionEvent` directly so TypeScript narrows the discriminated union without an `as` cast; overflow recovery now calls a new `bumpCompactionCount()` helper instead of fabricating a partial event ([#174](https://github.com/diegoscarabelli/system2/pull/174))
- `AgentHost.handlePotentialError` no longer resends in-flight deliveries when the API call fails after the model has already emitted output (`message_start` / `message_update` / `tool_execution_start`). Previously, a `Request timed out` mid-turn would trigger the retry-resend path, re-feeding the same delivery to the model and re-running any side effects (e.g. file edits) the tool calls had already committed before the connection dropped. The narrator's ad-hoc dedup ("section already exists, skipping") masked the duplicates but did not prevent them. The host now tracks `currentTurnHasOutput` per turn (set on output events, reset on `turn_start` and `agent_end`) and, when contamination is detected on failure, rejects all pending delivery promises with a transient error and skips the resend. The job's awaiter (e.g. `trackJobExecution`) marks the job failed, the cursor (`last_narrator_update_ts`) is not advanced, and the next cron tick redoes the window from scratch with the recipient's idempotency handling whatever partial work landed on disk. Fixes [#175](https://github.com/diegoscarabelli/system2/issues/175) ([#177](https://github.com/diegoscarabelli/system2/pull/177)).

## [0.3.3] - 2026-05-10

### Added

- New shared `Markdown` wrapper component (`src/ui/components/Markdown.tsx`) around `react-markdown` that always applies `remark-gfm`. All four `react-markdown` call sites (`ArtifactViewer`, `MessageList`, `TaskDetailModal`, `ProjectDetailModal`) now route through the wrapper so GFM tables, strikethrough, autolinks, and task lists render consistently. Chat `MarkdownContent` also gained table border styling so chat tables visually match the artifact viewer. Adds `remark-gfm@4.0.1` dependency.

### Changed

- `agent_busy_state` is now the single source of truth for per-agent context-usage % in the UI. Both `AgentPane` (via overlay onto `/api/agents` data) and `MessageInput` (via the active agent's entry in `usePushStore.agentBusy`) read the same map. The chat store no longer carries a `contextPercent` field, and the WebSocket handler unicasts an `agent_busy_state` snapshot on initial connect (for the Guide) and on `switch_agent` (for the newly focused agent) to seed the client's view before the first busy transition.
- WebSocket message `agent_busy_changed` is renamed to `agent_busy_state`. The payload is identical (`agentId`, `busy`, `contextPercent`); the new name reflects that the message represents the agent's current state (sent as both a broadcast on transitions and a unicast snapshot on connect/switch), not strictly a "change" event.
- Shared Knowledge Files now use `>` blockquotes as section-instruction scaffolding that the Guide preserves rather than folds into or replaces. `src/server/agents/agents.md` gains a Shared Knowledge Files editing-convention block (right-shape example + common wrong shapes to avoid), and the `INFRASTRUCTURE_TEMPLATE` in `src/server/knowledge/templates.ts` surfaces the same convention near the top of the generated file. The `app_writer` credentials example is also reverted to the simple `~/repos/my_pipelines/.env` pattern matching the standard setup.

### Fixed

- GFM tables, strikethrough, autolinks, and task lists in markdown content rendered as plain text (e.g. literal `|` characters in tables) in the artifact viewer, chat, and task/project description modals. Root cause: `react-markdown` was wired in without `remark-gfm`, so only CommonMark was parsed. Fixed by routing all call sites through the new shared `Markdown` wrapper (see Added).
- `AgentHost.deliverMessage` no longer rejects with `Agent is reinitializing, delivery rejected` when a delivery lands during a reset+reinit window. Deliveries are now queued in `pendingDeliveries` and replayed against the fresh session by the existing replay path (`replayPendingDeliveries` after a scheduled-task reset, or the inline replay loop in `reinitializeWithProvider` for failovers). The "uninitialized" reject still fires when `initialize()` has genuinely never run. Fixes #169 — the back-to-back catch-up race where `memory-update / catch-up` was rejected because the preceding `daily-summary / catch-up`'s `agent_end` had just kicked off the Narrator's post-scheduled-task reset+reinit.
- `reinitializeWithProvider`'s replay loop now iterates the merged set of deliveries (pre-failover snapshot + entries queued during reinit) instead of just the snapshot. Previously a no-op because the early reject made `newDuringReinit` unreachable; load-bearing now that `deliverMessage` queues during reinit.
- The context-usage % shown in `MessageInput` (chat input "X% used") could disagree with the same agent's `Context %` column in `AgentPane`. The two displays were driven by separate WebSocket messages with different fire cadences: `context_usage` (only on agent focus and `agent_end`) drove the chat input; `agent_busy_changed` (every busy transition) drove the table. Around a turn boundary that included compaction or a failover-driven `compactForProvider`, the chat input could be left holding the pre-compaction value while the table reflected the post-compaction value (or vice versa). (This release also renames `agent_busy_changed` to `agent_busy_state` — see the Changed section.)
- `git-commit.test.ts` `commitIfStateDir` describe-block timeout raised from vitest's 5s default to 15s. The five tests each run a synchronous git command chain (init, config, commit, log, rev-list) against a tempdir, and on `windows-latest` runners these chains intermittently exceeded the 5s ceiling. Locally and on Linux/macOS they finish in well under a second; the 15s headroom is a safety net for slow runners, not a real expectation.

### Removed

- `context_usage` WebSocket message type and its emitters (`handler.ts` on focus + on `agent_end`) and consumer (`useWebSocket.ts`). The `tokens` and `contextWindow` fields it carried weren't consumed anywhere in the UI; `agent_busy_state` already covers every moment `context_usage` used to fire.
- `setContextPercent` action and the `contextPercent` field on `PerAgentState` in `chat.ts`. `MessageInput` now reads from `usePushStore` instead.

## [0.3.2] - 2026-05-06

### Added

- New agent skill `editing-config-toml` (`src/server/agents/skills/editing-config-toml/SKILL.md`). Covers the whole `~/.system2/config.toml` editing flow: file purpose, what lives in `.auth.toml` instead, editing protocol (`read`-then-`edit`, never `write`, daemon restart, gitignore behavior), the per-adapter database reference (auto-generated from the schema), credential-fallback table (auto-generated), and short reference for non-database sections. Available to `guide`, `conductor`, and `worker` roles.
- Build-time generator `pnpm generate:db-reference` derives the per-adapter field tables and credential-fallback table for both the new skill and `docs/configuration.md` from the schema. Each rendered region lives between `<!-- BEGIN auto-generated:* -->` / `<!-- END auto-generated:* -->` markers; everything outside the markers stays hand-written. A vitest drift test (`databases-reference-generator.test.ts`) re-runs the generator and fails CI if the on-disk content diverges, prompting the developer to run the generator and commit the regenerated content.

### Changed

- `[databases.<name>]` entries in `~/.system2/config.toml` are now validated against a TypeBox schema (`src/shared/types/databases-schema.ts`) instead of a hand-maintained loader. Each of the 8 supported adapters (postgres, mysql, mssql, clickhouse, snowflake, bigquery, sqlite, duckdb) has its own sub-schema, with required-vs-optional fields verified against each driver's official connection contract.
- Validation rejects misconfigured entries at startup with a precise per-field diagnostic instead of silently loading and failing later at adapter-connect. Notable behaviour changes vs 0.3.1: snowflake without `account` is rejected at startup with `missing required field "account" for type "snowflake"`; bigquery without `project` is rejected; mssql without `user` or `password` is rejected; snowflake without either `password` or `credentials_file` produces a snowflake-specific error explaining the basic-auth vs key-pair-auth choice. No migration required.
- Snowflake validation errors that fall outside the special cases above (e.g. wrong type for `warehouse`) are now reported against the closest-matching inner variant of the `Type.Union`, instead of bottoming out at TypeBox's opaque "expected union value" diagnostic.
- The `type` discriminator now distinguishes "missing" from "wrong type": `type = 42` reports `field "type" must be a string (got number)` instead of "missing required field". Truly missing `type` and unknown string types continue to report their own messages.
- Unknown fields in `[databases.<name>]` blocks (e.g. typos like `passw = "..."`) are still accepted (lax behaviour preserved) but now logged as warnings with a Levenshtein "did you mean" hint, mirroring `validateLlmModels`.
- Numeric range handling for `query_timeout`, `port`, and `max_rows` matches 0.3.1: out-of-range values are dropped (entry still loads with the field unset) instead of rejecting the entry. The schema's range expectations are documented via per-field annotations and surfaced in the auto-generated reference table.
- The 0.3.1 `_databaseTomlCoverage` compile-time guard is replaced with `_databaseSchemaCoverage`, which checks that every property key appearing on any schema variant is also a key on the broad `DatabaseConnectionConfig` runtime interface. Adding a field to a schema variant without also exposing it on the interface now fails `tsc`. (The guard checks key coverage, not property-type assignability — the latter would require richer schema introspection. The class problem behind the 0.3.1 `password`-drop bug, where a schema field was structurally absent from the interface, is now caught.)

### Fixed

- `buildConfigToml()` no longer emits `database = "undefined"` for adapter configs without a `database` field (snowflake can omit it and rely on `USE database` per-query). The line is now only emitted when `conn.database !== undefined`.

### Removed

- The inline database-setup section in `system2-onboarding/SKILL.md` (~30 lines of TOML examples and editing protocol) is replaced with a single `REQUIRED SUB-SKILL: editing-config-toml` cross-reference. The Guide pulls up the editing skill on demand during onboarding instead of inlining the per-adapter examples, eliminating the partial duplication that would otherwise drift from the schema.
- The hand-written `### Credentials` table in `docs/configuration.md` (carry-over from before this PR). The auto-generated credential-fallback table further down the same file is now the single source.

## [0.3.1] - 2026-05-06

### Added

- `xhigh` is now a valid `thinking_level` for `[agents.<role>]` overrides in `config.toml`. Routes through pi-ai's adaptive thinking: on Opus 4.7 it maps to native `xhigh`, on Opus 4.6 to `max`, on gpt-5.2+ to `max`; on models without an extended tier (Sonnet 4.6 and earlier Claude, older OpenAI/Bedrock) it gracefully degrades to `high`. Library defaults are unchanged; opt in per role.

### Fixed

- Anthropic 5xx errors (`api_error`, `overloaded_error`) were classified as `unknown` instead of `transient` because the Pi SDK surfaces them as a JSON-stringified body with no numeric HTTP status (e.g. `{"type":"error","error":{"type":"api_error","message":"Internal Server Error"},"request_id":"..."}`), and the loose `\b(4\d{2}|5\d{2})\b` regex in `extractStatusCode` had nothing to match. `extractStatusCode` now parses the JSON envelope and maps Anthropic's documented `error.type` values back to HTTP status codes (`api_error` → 500, `overloaded_error` → 529, `authentication_error` → 401, etc.), so all error.type variants flow through the existing status-code switch in `categorizeError`. This restores the expected retry budget on a transient brownout: same-provider retries are attempted before falling over to the next credential.
- Database passwords set in `~/.system2/config.toml` (e.g. `[databases.<name>] password = "..."`) were silently dropped by the loader. The `TomlConfigFile.databases` interface didn't list `password`, and `convertTomlDatabases` didn't copy it into the runtime `DatabaseConnectionConfig` — even though the runtime types and every adapter (postgres, mysql, mssql, clickhouse) expect it. Symptom: a user followed `docs/configuration.md` (which documents `password` as the primary credential source), saw their dashboard fail to authenticate, and had no log line explaining why. Now `password` is read from TOML and forwarded to the adapter. When the field is omitted, drivers continue to fall back to their native credential mechanisms (e.g. `~/.pgpass`, `~/.my.cnf`, `MYSQL_PWD`, `MSSQL_PASSWORD`) as documented. The `config.toml` template intro and `[databases.mydb]` example were updated to clarify that LLM/service credentials live in `.auth.toml` while database passwords belong here. A compile-time coverage guard was added to `convertTomlDatabases`: any field added to `DatabaseConnectionConfig` without also being added to `TomlConfigFile.databases` will now fail `tsc`, preventing the same silent-drop class from recurring.

## [0.3.0] - 2026-05-01

### Added

- OAuth subscription support for OpenAI Codex (ChatGPT) and GitHub Copilot, alongside the existing Anthropic Claude Pro/Max flow. Pi-ai's `getOAuthProvider(id)` registry drives login, refresh, and per-provider apiKey formatting. Per-agent model declarations for the new providers are added to every agent frontmatter (`narrator`, `conductor`, `guide`, `worker`, `reviewer`). ChatGPT Free is supported via the Codex CLI flow; Anthropic OAuth still requires a paid plan (Pro/Max/Team/Enterprise).
- Tier-aware OAuth model selection. `[llm.oauth]` resolves a single capability-tier model per provider via a family-prefix regex against pi-ai's catalog (`claude-opus-*` for anthropic, `gpt-X.Y[-codex]` for openai-codex, `gpt-X.Y` for github-copilot), so newer flagships propagate automatically when pi-ai bumps. Users can pin a specific model via `[llm.oauth.<provider>] model = "..."`. The resolver applies a natural-sort comparator (numeric segments compared as numbers, so `5.10 > 5.4`) and a snapshot filter (aliases beat date-pinned snapshots).
- Runtime fallback hook for OAuth: when an auto-resolved model returns 403 or 404, the host steps that credential to a hardcoded fallback (`claude-sonnet-4-6`, `gpt-5.4`, `gpt-4.1`) for the rest of the session. Per-provider tracking so a step-down on one credential doesn't pre-emptively downgrade unrelated OAuth providers in the failover chain. Explicit user pins skip auto-fallback so misconfiguration surfaces loudly.
- `[llm.api_keys.<provider>.models]` (table with `<role> = "..."` keys inside) per-role model pins for the API-keys tier. Pin scope is now self-evident from the TOML path.
- Startup validation: `validateAgentModels` covers agent frontmatter, and `validateLlmModels` walks `llm.oauth.providers[*].model` and `llm.providers[*].models[*]` against pi-ai's catalog with Levenshtein-nearest "did you mean" hints, catching typos before a runtime API failure.
- Visual section dividers (`# ═══...═══`) in the generated `config.toml`, around: Per-agent behavior overrides, Tools, Databases, Operational settings. (OAuth tier, API keys tier, and Services moved to `.auth.toml` later in this release; that file is emitted by `TOML.stringify` with only a do-not-edit header.)

### Changed

- New config schema: API keys nest under `[llm.api_keys]` (with `primary`, `fallback`, and per-provider keys at `[llm.api_keys.<provider>]`) as a sibling of `[llm.oauth]`. Both tiers read top-to-bottom in priority order. The internal `AuthTier` type was renamed `'keys'` → `'api_keys'` to match (runtime-only: cooldown key namespace + log output; no on-disk state affected). The legacy 0.2.x `[llm].primary` + sibling `[llm.<provider>]` flat shape and the `[agents.<role>.models]` location are no longer parsed; users with those shapes see a startup parse error and update manually (no auto-migration).
- `[agents.<role>]` now carries only `thinking_level` and `compaction_depth`. Per-role model pins moved to `[llm.api_keys.<provider>.models]` (table with `<role> = "..."` keys inside).
- Renamed agent library frontmatter `models:` block to `api_keys_models:` to make its tier scope explicit. The OAuth tier ignores frontmatter (it picks one model per provider via the resolver); only the API-keys tier reads these defaults. The `github-copilot` and `openai-codex` entries (OAuth-only providers) were dropped from every role's frontmatter — they were dead defaults that the api-keys tier could never reach.
- `system2 onboard` replaced by `system2 init` (directory scaffolding only: creates `~/.system2/` and writes a templated `config.toml`) plus `system2 config` (interactive credential and service management). On a fresh install, `system2 init` auto-invokes `system2 config` so first-run UX is still one command.
- `system2 config` is a re-entrant top-level menu with three submenus: OAuth providers, API key providers, and Services. The OAuth submenu lists all providers (already-logged-in entries annotated, primary marked); selecting a fresh provider runs the OAuth flow and auto-patches `[llm.oauth]`, and selecting an already-logged-in provider opens a contextual menu (re-login, set as primary, remove, cancel). A failed OAuth login surfaces the error and returns to the OAuth submenu, where the user can pick the same provider to retry, pick a different one, or "Back to main menu" to skip — the same 3-way recovery the old onboarding wizard offered, expressed structurally via the menu instead of a dedicated prompt.
- API-key providers and Brave Search are now manageable post-install via `system2 config` (previously required hand-editing `config.toml`).
- Both `[llm.oauth]` and `[llm.api_keys]` failover chains can be reordered interactively via `system2 config` → submenu → "Reorder fallbacks" (move up / down / to top / to bottom). Primary stays sticky and is set per-provider via "Set as primary" (unchanged).
- `system2 start` validates that at least one credential tier has a configured primary before forking the daemon, with a friendly pointer to `system2 config` if not.
- OAuth `onAuth` callback now reads `instructions` alongside `url` so device-flow user codes (Copilot) are surfaced in the terminal. The shared `formatOAuthAuthMessage` helper is used wherever OAuth flows are invoked from the CLI.
- OAuth dispatcher API: `oauth.ts` exports `loginProvider(provider, callbacks)` and `refreshOAuthToken(provider, credentials)` (replacing `loginAnthropic` / `refreshAnthropic`). Refresh now operates on the full credential object, preserving provider-specific extras (e.g. Copilot's `enterpriseDomain`) through the round-trip. `AuthResolver.ensureFresh`'s `refresh` callback changed from `(refreshToken: string) => Promise<RefreshedTokens>` to `(provider, credentials: OAuthCredentials) => Promise<OAuthCredentials>` (the `RefreshedTokens` type is removed).
- `validateAgentModels` signature simplified to take a flat `Record<role, Record<provider, modelId>>` instead of a wrapped `AgentsConfig`.
- Split `~/.system2/config.toml` into two files: `config.toml` (user-edited operational settings: `[agents.*]`, `[databases.*]`, `[backup]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`, `[session]`, `[delivery]`, top-level `web_search_max_results`) and `auth/.auth.toml` (credentials and service toggles: `[llm.oauth]`, `[llm.api_keys]`, `[services.*]`, `[tools.web_search].enabled`, written exclusively by `system2 config`). With the auth state in its own file, the 1100-line regex-based `toml-patchers.ts` collapsed to ~150 lines of parse-mutate-write via `@iarna/toml`, eliminating an entire class of patcher bugs (stub replacement, EOF placement, sub-section repair on hand-edit damage, control-char escaping in user input, comment-preservation around managed blocks). `.auth.toml` is created by `system2 config` on the first credential write; `system2 init` does not create it.
- Renamed `~/.system2/oauth/` to `~/.system2/auth/` (now also holds `.auth.toml` alongside the per-provider credential JSONs). Directory permissions are `0700`, files inside are `0600`.
- Renamed `[tools.web_search].max_results` to a top-level `web_search_max_results` scalar in `config.toml`. The `[tools.web_search].enabled` flag now lives in `.auth.toml` (managed via `system2 config`).

### Removed

- `system2 logout` command. The remove flow is now reached via `system2 config` → OAuth providers → select the provider → "Remove".
- `system2 login` command. OAuth management moves to `system2 config` → OAuth providers.
- Per-credential `label` field on OAuth credentials. OAuth credentials are stored one-per-provider (`~/.system2/auth/<provider>.json` in 0.3.0; was `~/.system2/oauth/<provider>.json` in 0.2.x) and the runtime never disambiguated them by label, so the field was vestigial. Login flow no longer prompts for a label; the provider id is used everywhere it's referenced (logs, UI, `[llm.oauth]` patcher addresses). Existing on-disk JSON files containing `label` still load — the extra field is ignored.
- `google-gemini-cli` and `google-antigravity` OAuth providers. Pi-ai 0.71.0 removed both because Google has been disabling user accounts that authenticate via these flows from third-party tools (pi-mono#4017, pi-mono#3999). System2 aligns to avoid the same user-safety risk. Existing `~/.system2/oauth/google-{gemini-cli,antigravity}.json` credential files are silently ignored at startup; safe to delete.

### Migration

0.3.0 is a clean break with no migration code. Existing 0.2.x installs must re-create `~/.system2/config.toml` and `~/.system2/auth/.auth.toml` by hand. The procedure (assumes you're upgrading from 0.2.x):

1. **Stop the daemon.** `system2 stop`.
2. **Snapshot your old config for reference.** `cp ~/.system2/config.toml ~/.system2/config.toml.0.2.x`.
3. **Move the active config aside** so `system2 init` will write a fresh template. `mv ~/.system2/config.toml ~/.system2/config.toml.bak`.
4. **Run `system2 init`.** It writes a fresh `config.toml` template and auto-launches `system2 config`.
5. **Re-enter credentials in `system2 config`** by reading them out of `config.toml.0.2.x`:
   - **OAuth providers** (Anthropic, OpenAI Codex, GitHub Copilot): pick "OAuth providers" → select each provider that was in `[llm.oauth]` → run the browser login. (`system2 config` writes `~/.system2/auth/.auth.toml` and saves the per-provider tokens at `~/.system2/auth/<provider>.json`.)
   - **API keys**: pick "API key providers" → for each provider that had keys in 0.2.x's `[llm.<provider>]` (flat shape, no longer parsed) or `[llm.api_keys.<provider>]`, re-enter the key(s) and labels. Multiple labeled keys per provider are supported for rotation.
   - **Brave Search**: pick "Services" → "Brave Search" → enter the key from `[services.brave_search]`. Setting it also flips `[tools.web_search].enabled = true` automatically.
   - Reorder failover priority on either tier with the "Reorder fallbacks" entry if your `fallback = [...]` order matters.
6. **Open the new `~/.system2/config.toml`** and copy across these operational sections from `config.toml.0.2.x` only if you had them customized (the new template has each section commented out at code defaults — uncomment AND copy the customized values):
   - `[agents.<role>]` blocks: copy `thinking_level` and `compaction_depth` verbatim. **Do not copy a `model = "..."` field if your 0.2.x `[agents.<role>]` had one** — per-role model pins moved to `[llm.api_keys.<provider>.models]` in `.auth.toml` and are not exposed in the `system2 config` menu. To pin a per-role model in 0.3.0, hand-edit `.auth.toml` once after `system2 config` finishes; subsequent `system2 config` writes preserve the addition through parse-mutate-write.
   - `[databases.<name>]` blocks: copy verbatim (schema unchanged).
   - `[backup]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`, `[session]`, `[delivery]` blocks: copy verbatim (schemas unchanged).
   - `[tools.web_search].max_results` (if customized): in 0.3.0 this is a top-level scalar in `config.toml` named `web_search_max_results = N` (no enclosing section).
7. **Delete the orphaned 0.2.x credential dir.** `rm -rf ~/.system2/oauth/` — the JSONs there are silently ignored by 0.3.0.
8. **Start the daemon.** `system2 start`. Verify it comes up cleanly and the Guide responds.
9. **Clean up the references.** `rm ~/.system2/config.toml.0.2.x ~/.system2/config.toml.bak`.

Other state is untouched by this upgrade: `app.db`, `~/.system2/sessions/`, `~/.system2/projects/`, `~/.system2/artifacts/`, `~/.system2/logs/`, and the git-tracked `~/.system2/knowledge/` files are all preserved through the procedure above.

### Dependencies

- Bumped `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-agent-core` from `^0.63.x` to `^0.71.1` (sibling packages move together). Adjusted call sites for two non-trivial API changes: `ModelRegistry`'s constructor became private (use `ModelRegistry.create(...)` instead), and pi-agent-core's `AgentTool.execute` now types schema fields permissively (each field treated as possibly undefined regardless of `Type.Optional`); tool implementations narrow once via `Static<typeof <toolName>Params>` at the top of the execute body.

## [0.2.2] - 2026-04-29

### Added

- New `archive_keep_count` field in the `[session]` config section (default 5) — caps the number of `.jsonl.archived` files retained per agent's session directory. Older archives are pruned by mtime after every successful rotation. Prevents unbounded archive accumulation introduced by the narrator session reset (~48 archives/day on the default 30-min cron) ([#157](https://github.com/diegoscarabelli/system2/pull/157))

### Fixed

- Narrator session JSONL is now reset to a fresh header after each completed scheduled task (via the new agent library frontmatter flag `reset_session_after_scheduled_task: true`, opt-in per role). Prevents the context-overflow cascade where each cron tick's restored session (long writeup + tool-call traces) plus the new catch-up delivery exceeded Haiku 4.5's 200K window. The Narrator's durable memory remains in `daily_summaries/*.md`, `memory.md`, and per-project `log.md`; only the in-session JSONL is cleared. The reset is robust across queued deliveries, malformed sessions, and Anthropic OAuth long-context misclassifier 429s. Other agents (Guide, Conductor, Reviewer) keep their conversational sessions ([#155](https://github.com/diegoscarabelli/system2/pull/155))

## [0.2.1] - 2026-04-29

### Added

- New `[session]` config section with tunable `rotation_size_bytes` (default 10 MB) for session JSONL rotation threshold ([#153](https://github.com/diegoscarabelli/system2/pull/153))

### Fixed

- Session JSONLs no longer grow unboundedly when the SDK never produces a compaction anchor (e.g., during sustained provider-failover cascades). Every threshold-exceeding cold start now rotates the file: anchored rotation when a compaction exists, bare-bytes-tail otherwise (header + up to 1 MB of recent entries aligned to a user-turn boundary), or header-only when the file is unreadable or anchor is malformed ([#153](https://github.com/diegoscarabelli/system2/pull/153))
- `bash.test.ts` "active output prevents inactivity timeout" test was flaky under system load: framework timeout (15s) could preempt the bash tool's `total_timeout_seconds=30`, producing exit code 124. Bumped framework timeout to 30s ([#153](https://github.com/diegoscarabelli/system2/pull/153))

## [0.2.0] - 2026-04-29

### Added

- Claude Pro/Max OAuth support with two-tier auth: OAuth credentials are exhausted before API keys, with automatic refresh-and-retry on 401. New `system2 login` and `system2 logout` CLI commands ([#145](https://github.com/diegoscarabelli/system2/pull/145), [#147](https://github.com/diegoscarabelli/system2/pull/147), [#148](https://github.com/diegoscarabelli/system2/pull/148))
- OAuth-aware startup banner shows OAuth and API key tiers separately ([#148](https://github.com/diegoscarabelli/system2/pull/148))
- New `[delivery]` config section with tunable `max_bytes` (default 1 MB), `catch_up_budget_bytes` (default 512 KB), and `narrator_message_excerpt_bytes` (default 16 KB) ([#149](https://github.com/diegoscarabelli/system2/pull/149))

### Changed

- Pruning compaction now fires on the next `agent_end` after `compaction_depth` is reached, regardless of context usage (previously gated at >= 30%) ([#144](https://github.com/diegoscarabelli/system2/pull/144))
- Increase narrator `compaction_depth` from 2 to 3 to reduce no-op pruning on small cron-driven turns ([#144](https://github.com/diegoscarabelli/system2/pull/144))
- Defer the `agent_end` signal (and `ready_for_input`) until pruning compaction completes, preventing a race where the UI could submit a prompt that interleaved with the in-flight compaction ([#144](https://github.com/diegoscarabelli/system2/pull/144))

### Fixed

- Bound inter-agent delivery sizes to prevent oversized-payload cascades: producer-side budget for catch-up payloads, transport cap on individual deliveries, and narrowed drop-pendings to wire-size errors only so token-window overflows still recover via compaction ([#149](https://github.com/diegoscarabelli/system2/pull/149))
- Agent coordination, completion, and message-burst guardrails ([#146](https://github.com/diegoscarabelli/system2/pull/146))

## [0.1.3] - 2026-04-22

### Changed

- Replace unreliable `fs.watch` with mtime polling for artifact live reload ([#143](https://github.com/diegoscarabelli/system2/pull/143))
  - New `GET /api/artifact-mtime` endpoint returns `{ mtimeMs }` via `fs.statSync`
  - UI polls active artifact tab every 2 seconds, reloads on mtime change
  - Tab switches now cache-bust iframe URLs for fresh content
  - `show_artifact` WebSocket messages cache-bust when targeting an already-open tab

### Removed

- Remove `FSWatcher` and `watchArtifact()` from WebSocket handler (replaced by mtime polling) ([#143](https://github.com/diegoscarabelli/system2/pull/143))

## [0.1.2] - 2026-04-22

First published release.

### Added

- Multi-agent orchestration with Conductor, Narrator, Analyst, and Guide roles
- React-based real-time chat UI with WebSocket communication
- HTML artifact system with sandboxed iframes
- postMessage query bridge for interactive dashboards ([#114](https://github.com/diegoscarabelli/system2/pull/114), [#142](https://github.com/diegoscarabelli/system2/pull/142))
- Built-in skills: `live-dashboard`, `sql-schema-modeling`, `statistical-analysis`, `review` ([#108](https://github.com/diegoscarabelli/system2/pull/108), [#116](https://github.com/diegoscarabelli/system2/pull/116), [#119](https://github.com/diegoscarabelli/system2/pull/119), [#142](https://github.com/diegoscarabelli/system2/pull/142))
- Git-tracked knowledge system with dynamic prompt injection
- SQLite database (WAL mode) for artifacts, chat history, and agent state
- Cron-based Narrator scheduler for automated summaries and memory updates
- CLI: `system2 onboard`, `system2 start`, `system2 stop`, `system2 status` with update notifier ([#142](https://github.com/diegoscarabelli/system2/pull/142))
- TimescaleDB/PostgreSQL integration for external analytics queries
- WebSocket push notifications for real-time UI updates ([#104](https://github.com/diegoscarabelli/system2/pull/104))
- Worker role for conductor-managed parallel execution ([#107](https://github.com/diegoscarabelli/system2/pull/107))
- Heartbeat protocol and dual timeouts for bash tool ([#112](https://github.com/diegoscarabelli/system2/pull/112))
- Timestamped logger module ([#111](https://github.com/diegoscarabelli/system2/pull/111))
- Error state and retry button for push-triggered panel fetches ([#109](https://github.com/diegoscarabelli/system2/pull/109))
- Guide welcome message on server startup ([#123](https://github.com/diegoscarabelli/system2/pull/123))
- Support for markdown, code, PDF, and image file types in artifact viewer ([#128](https://github.com/diegoscarabelli/system2/pull/128))
- Write tool warns when overwriting existing files ([#130](https://github.com/diegoscarabelli/system2/pull/130))
- Per-role agent config overrides and OpenRouter Gemini defaults ([#118](https://github.com/diegoscarabelli/system2/pull/118))
- LLM failover across providers (Anthropic, OpenRouter, OpenAI-compatible)

### Fixed

- Prevent delivery promises from hanging during provider failover ([#139](https://github.com/diegoscarabelli/system2/pull/139))
- Upgrade Gemini models and improve onboarding reliability ([#140](https://github.com/diegoscarabelli/system2/pull/140))
- Resolve Windows CI test failures ([#137](https://github.com/diegoscarabelli/system2/pull/137))
- Conductor task granularity, narrator hardening, and context overflow recovery ([#134](https://github.com/diegoscarabelli/system2/pull/134))
- Persist project `dir_path` in `app.db` ([#133](https://github.com/diegoscarabelli/system2/pull/133))
- Improve inter-agent communication reliability ([#132](https://github.com/diegoscarabelli/system2/pull/132))
- Prevent write tool from overwriting `config.toml` ([#129](https://github.com/diegoscarabelli/system2/pull/129))
- Delivery send count race with `agent_end` ([#127](https://github.com/diegoscarabelli/system2/pull/127))
- Unify knowledge file commits via `commitIfStateDir` ([#125](https://github.com/diegoscarabelli/system2/pull/125))
- Fall back to Guide when persisted agent no longer exists ([#122](https://github.com/diegoscarabelli/system2/pull/122))

[Unreleased]: https://github.com/diegoscarabelli/system2/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/diegoscarabelli/system2/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/diegoscarabelli/system2/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/diegoscarabelli/system2/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/diegoscarabelli/system2/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/diegoscarabelli/system2/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/diegoscarabelli/system2/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/diegoscarabelli/system2/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/diegoscarabelli/system2/releases/tag/v0.1.2
