# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/diegoscarabelli/system2/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/diegoscarabelli/system2/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/diegoscarabelli/system2/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/diegoscarabelli/system2/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/diegoscarabelli/system2/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/diegoscarabelli/system2/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/diegoscarabelli/system2/releases/tag/v0.1.2
