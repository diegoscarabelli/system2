# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Pruning compaction now fires on the next `agent_end` after `compaction_depth` is reached, regardless of context usage (previously gated at >= 30%) ([#144](https://github.com/diegoscarabelli/system2/pull/144))
- Increase narrator `compaction_depth` from 2 to 3 to reduce no-op pruning on small cron-driven turns ([#144](https://github.com/diegoscarabelli/system2/pull/144))
- Defer the `agent_end` signal (and `ready_for_input`) until pruning compaction completes, preventing a race where the UI could submit a prompt that interleaved with the in-flight compaction ([#144](https://github.com/diegoscarabelli/system2/pull/144))

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

[0.1.3]: https://github.com/diegoscarabelli/system2/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/diegoscarabelli/system2/releases/tag/v0.1.2
