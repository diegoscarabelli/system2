# Configuration

System2 settings are split across two files in 0.3.0. `~/.system2/config.toml` holds user-edited operational settings only: per-agent behavior overrides, database connections, the `web_search_max_results` knob, and operational defaults (`[backup]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`, `[session]`, `[delivery]`). It is created by `system2 init` with `0600` permissions, read by the daemon, and never written by it.

`~/.system2/auth/auth.toml` holds machine-managed credentials: `[llm.oauth]`, `[llm.api_keys]`, `[services.brave_search]`, and the `[tools.web_search].enabled` flag. It lives under a `0700` directory with file mode `0600`, and is written exclusively by [`system2 config`](cli.md#system2-config). Do NOT hand-edit `auth.toml`: every `system2 config` write rewrites the file via parse-mutate-stringify, so any user-added comments or hand-chosen key order are lost. The file is created on first credential write; `system2 init` does not create it.

**Key source files:**

- `src/shared/types/config.ts`: TypeScript types
- `src/cli/utils/config.ts`: `loadConfig` reads BOTH files and composes the in-memory config; also emits the `config.toml` template
- `src/cli/utils/auth-config.ts`: `auth.toml` on-disk type and the `withAuth` parse-mutate-write helper
- `src/cli/utils/toml-patchers.ts`: thin parse-mutate-write patchers driven by `system2 config`
- `src/server/agents/auth-resolver.ts`: failover logic

## File Reference

### `~/.system2/config.toml` (user-edited operational settings)

```toml
# System2 Configuration
# User-edited operational settings: per-agent overrides, databases, and
# operational defaults (backup, logs, scheduler, chat, knowledge, session,
# delivery, web_search_max_results).
#
# LLM credentials (OAuth + API keys) and service credentials live in a
# separate file: ~/.system2/auth/auth.toml, managed by `system2 config`.
# Do not put credentials here — the loader does not read them from this file.
#
# Changes apply on daemon restart.
# Permissions: 0600 (owner read/write only).

# ════════════════════════════════════════════════════════════════════════
# Per-agent behavior overrides
# ════════════════════════════════════════════════════════════════════════
# Tier-agnostic: applied whether the OAuth or API-keys tier is active.
# Supported roles: guide, conductor, reviewer, narrator, worker.
# Model pins live in auth.toml (managed by `system2 config`).
[agents.guide]
thinking_level = "medium"           # off | minimal | low | medium | high
compaction_depth = 5                # keep N auto-compactions in sliding window

# ════════════════════════════════════════════════════════════════════════
# Tools
# ════════════════════════════════════════════════════════════════════════
# Operational knobs for tool behavior. Tool credentials and the
# `[tools.web_search].enabled` flag live in auth.toml.
#
# Maximum number of results returned by the web_search tool. Top-level
# scalar (no enclosing section). Default pinned in code
# (DEFAULT_WEB_SEARCH_MAX_RESULTS = 5). Uncomment to override.
# web_search_max_results = 5

# ════════════════════════════════════════════════════════════════════════
# Databases
# ════════════════════════════════════════════════════════════════════════
# [databases.my_postgres]
# type = "postgres"
# database = "analytics"
# user = "readonly"

# ════════════════════════════════════════════════════════════════════════
# Operational settings
# ════════════════════════════════════════════════════════════════════════
# All values below are defaults pinned in code (src/cli/utils/config.ts:
# DEFAULT_OPERATIONAL, DEFAULT_SESSION, DEFAULT_DELIVERY). Lines are
# commented so accidental edits cannot change runtime behavior — to
# tune a value, uncomment its section header AND the specific key, then
# restart the daemon. Values left commented stay tied to the code default,
# so an upgrade that bumps a default propagates automatically.

# [backup]
# # Hours between automatic backups (minimum: 1)
# cooldown_hours = 24
# # Maximum number of automatic backups to keep
# max_backups = 3

# [logs]
# # Log file size threshold for rotation in MB
# rotation_threshold_mb = 10
# # Maximum number of archived log files to keep
# max_archives = 5

# [scheduler]
# # Minutes between daily summary runs
# daily_summary_interval_minutes = 30

# [chat]
# # Maximum number of chat messages to keep in UI history
# max_history_messages = 100

# [knowledge]
# # Maximum characters per knowledge file before truncation
# budget_chars = 20000

# [session]
# # Rotation threshold in bytes. Above this size, the JSONL is rotated.
# # Anchored if a compaction anchor exists, bare-bytes-tail otherwise.
# rotation_size_bytes = 10485760
# # Max .jsonl.archived files retained per agent's session directory.
# archive_keep_count = 5

# [delivery]
# # Hard cap on the size of any single inter-agent delivery, in bytes.
# max_bytes = 1048576
# # Total-size cap on the Narrator's catch-up prompt, in bytes. The daily-
# # summary cron (and the trigger_project_story tool) assembles ONE delivery
# # for the Narrator by gathering recent entries from agent session JSONL
# # files (inter-agent messages, project log updates, DB changes since the
# # Narrator's last run). If the assembled bundle would exceed this, the
# # oldest entries are dropped first.
# catch_up_budget_bytes = 524288
# # Per-entry truncation cap applied while assembling the catch-up prompt
# # above. Each individual JSONL entry's content is clipped to this size
# # before concatenation, so one bloated entry (e.g. a worker that pasted a
# # 1 MB tool result into a delivery) cannot eat the whole catch-up budget.
# narrator_message_excerpt_bytes = 16384
```

### `~/.system2/auth/auth.toml` (machine-managed credentials)

Written exclusively by [`system2 config`](cli.md#system2-config). Do NOT hand-edit: every write rewrites the file via parse-mutate-stringify, so comments and key order are not preserved. Lives under a `0700` directory with file mode `0600`. Created on first credential write (not by `system2 init`).

```toml
# Managed by 'system2 config' — do not edit by hand.
# Comments and key order are not preserved across writes.

# ─── LLM credentials — OAuth tier ────────────────────────────────────────
# OAuth providers and failover order. Subscription tokens live in
# ~/.system2/auth/<provider>.json (mode 0600), managed by `system2 config`.
# This tier is tried first; the API-keys tier below is only used after
# every OAuth credential is in cooldown.
# Supported providers: anthropic, openai-codex, github-copilot.

[llm.oauth]
primary = "anthropic"
fallback = []   # any of: anthropic, openai-codex, github-copilot

# Optional per-OAuth-provider model pin. When omitted, the resolver picks
# the family flagship from pi-ai's catalog.
# Catalog of model IDs (use the exact `id` field when pinning):
# https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts
[llm.oauth.anthropic]
model = "claude-opus-4-7"

# ─── LLM credentials — API keys tier ─────────────────────────────────────
# Pay-per-token. Each provider can hold multiple keys; rotation across keys
# and providers happens automatically on failures.

[llm.api_keys]
primary = "anthropic"
fallback = ["google", "openai"]

[llm.api_keys.anthropic]
keys = [{ key = "sk-ant-...", label = "personal" }, { key = "sk-ant-...", label = "work" }]

# Optional per-role model pins for the API-keys tier. Keys are role names
# (guide, conductor, reviewer, narrator, worker). Overrides the default
# from the role's frontmatter for the matched provider.
[llm.api_keys.anthropic.models]
narrator = "claude-haiku-4-5-20251001"
conductor = "claude-sonnet-4-6"

[llm.api_keys.cerebras]
keys = [{ key = "csk-...", label = "default" }]

[llm.api_keys.google]
keys = [{ key = "AIza...", label = "default" }]

[llm.api_keys.groq]
keys = [{ key = "gsk_...", label = "default" }]

[llm.api_keys.mistral]
keys = [{ key = "...", label = "default" }]

[llm.api_keys.openai]
keys = [{ key = "sk-...", label = "default" }]

[llm.api_keys.openrouter]
keys = [{ key = "sk-or-...", label = "default" }]

# Upstream provider routing for OpenRouter models (optional).
# Keys are model ID prefixes; quote them when they contain special characters (e.g. "/").
# Values are provider order arrays.
[llm.api_keys.openrouter.routing]
google = ["google-vertex/global", "google-vertex", "google-ai-studio"]

[llm.api_keys.xai]
keys = [{ key = "xai-...", label = "default" }]

# OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, Thaura, etc.)
[llm.api_keys.openai-compatible]
keys = [{ key = "sk-...", label = "default" }]
base_url = "http://localhost:4000/v1"
model = "my-model"
compat_reasoning = true             # optional, default true

# ─── Services ────────────────────────────────────────────────────────────
[services.brave_search]
key = "BSA..."

# ─── Tools ───────────────────────────────────────────────────────────────
# Only `enabled` lives in auth.toml. The `max_results` knob is a top-level
# scalar `web_search_max_results` in config.toml.
[tools.web_search]
enabled = true
```

## Sections

| Section | File | Description | TypeScript Type |
| ------- | ---- | ----------- | --------------- |
| `[llm.api_keys]` | `auth.toml` | API-key tier: primary provider, fallback order, per-provider keys | `LlmConfig` |
| `[llm.api_keys.<provider>.models]` | `auth.toml` | Per-role model pins for the API-keys tier (keys are role names) | `LlmProviderConfig.models` |
| `[llm.oauth]` | `auth.toml` | OAuth tier: primary + fallback subscription providers (tried first) | `LlmOAuthConfig` |
| `[llm.oauth.<provider>]` | `auth.toml` | Optional per-OAuth-provider model pin (`model = "..."`) | `LlmOAuthProviderConfig` |
| `[services.*]` | `auth.toml` | External service credentials | `ServicesConfig` |
| `[tools.web_search]` | `auth.toml` | `enabled` flag only (the `max_results` knob lives in `config.toml`) | `ToolsConfig.web_search.enabled` |
| `[agents.*]` | `config.toml` | Per-role behavior overrides (`thinking_level`, `compaction_depth`) | `AgentsConfig` |
| `web_search_max_results` | `config.toml` | Top-level scalar (no enclosing section). Tunable result cap for the `web_search` tool. | `ToolsConfig.web_search.max_results` |
| `[databases.*]` | `config.toml` | External database connections | `DatabasesConfig` |
| `[backup]` | `config.toml` | Auto-backup frequency and retention | -- |
| `[logs]` | `config.toml` | Log rotation threshold and archive count | -- |
| `[scheduler]` | `config.toml` | Narrator job scheduling | `SchedulerConfig` |
| `[chat]` | `config.toml` | Chat history settings | `ChatConfig` |
| `[knowledge]` | `config.toml` | Knowledge file size budget | `KnowledgeConfig` |
| `[session]` | `config.toml` | Session JSONL rotation threshold | `SessionConfig` |
| `[delivery]` | `config.toml` | Inter-agent delivery size bounds | `DeliveryConfig` |

## LLM Providers

| Provider | Models Used |
|----------|------------|
| `anthropic` | Claude (Sonnet, Opus, Haiku); also supports OAuth (Claude Pro/Max) |
| `cerebras` | Fast inference (Llama, Qwen) |
| `google` | Gemini |
| `groq` | Fast inference (Llama, DeepSeek, Gemma) |
| `mistral` | Mistral Large/Medium/Small, Magistral |
| `openai` | GPT, o-series |
| `openai-compatible` | Any OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, Thaura) |
| `openrouter` | Any model via OpenRouter (uses `provider/model` IDs) |
| `xai` | Grok |
| `openai-codex` | OAuth-only: ChatGPT account via the OpenAI Codex CLI flow. Reaches the gpt-5.x line plus codex-specialized variants. |
| `github-copilot` | OAuth-only: GitHub Copilot subscription. Mixed lineup including Claude Sonnet/Haiku and GPT-5 variants. |

Each provider supports multiple labeled keys for rotation. Keys are tried in order until one succeeds.

## Delivery Size Bounds

To prevent oversized inter-agent deliveries from triggering provider context-overflow errors or cooldown cascades, the `[delivery]` section configures producer-side size limits:

| Setting | Default | Purpose |
|---------|---------|---------|
| `max_bytes` | 1048576 (1 MB) | Hard cap on the size of any single inter-agent delivery, in bytes (~25% of a 1M-token context window). The loud-fail boundary at which a delivery is rejected outright. |
| `catch_up_budget_bytes` | 524288 (512 KB) | Total-size cap on the Narrator's catch-up prompt. The daily-summary cron (and the `trigger_project_story` tool) assembles **one** delivery for the Narrator by gathering recent entries from agent session JSONL files (inter-agent messages, project log updates, DB changes since the Narrator's last run). Set to half of `max_bytes` by default to leave headroom for headers, DB-changes sections, and SDK overhead. When the assembled bundle would exceed this, the oldest entries are dropped first. |
| `narrator_message_excerpt_bytes` | 16384 (16 KB) | Per-entry truncation cap applied **while assembling** the catch-up prompt above. Each individual JSONL entry's content (typically a `custom_message` between agents) is clipped to this size before concatenation, so one bloated entry (e.g. a worker that pasted a 1 MB tool result into a delivery) cannot eat the whole catch-up budget. Used by both the daily-summary cron and the `trigger_project_story` tool. |

**Invariant:** `catch_up_budget_bytes` must be less than `max_bytes`. This is validated at startup; if violated, a warning is logged.

When a catch-up delivery (e.g., daily summary) exceeds `catch_up_budget_bytes`, the oldest activity entries are dropped first, with a note prepended: `[NOTE: dropped N oldest entries spanning timestamp-A → timestamp-B to fit within delivery budget]`. The server logs this action at warn level. Cursor advancement is unaffected: the `last_narrator_update_ts` advances to the current run timestamp regardless, so dropped entries are intentionally not re-scanned.

For the `message_agent` tool, if a single message payload exceeds `max_bytes`, it is synchronously rejected with error code `message_too_large`.

## Session Rotation

Each agent appends turns to a JSONL session file under `~/.system2/sessions/<role>_<id>/`. Files grow without bound unless rotated. The `[session]` section configures a single rotation threshold; the rotation strategy is chosen by whether a compaction anchor exists in the file:

| Setting | Default | Purpose |
|---------|---------|---------|
| `rotation_size_bytes` | 10485760 (10 MB) | Rotation threshold. On agent cold start, if the active JSONL exceeds this size, the file is rotated and the old one is renamed to `<filename>.jsonl.archived`. |
| `archive_keep_count` | 5 | Maximum number of `.jsonl.archived` files retained per agent's session directory. After every successful rotation (size-based on cold start, or the per-task narrator session reset), older archives are pruned by mtime so disk usage stays bounded for high-volume agents. The Narrator alone produces ~48 archives/day on a 30-min cron; without a cap, archive disk grows monotonically. |

**Two inner paths, one threshold.** Once `rotation_size_bytes` is exceeded:

- **Anchored rotation (compaction anchor present).** Rotation copies forward starting from the latest compaction `firstKeptEntryId`. This is the normal case.
- **Bare-bytes-tail rotation (no compaction anchor).** Rotation force-keeps the session header + a bounded recent tail (cap ~1 MB), then advances the cut to the first user-turn entry in that window so the rotated file restarts on a safe API-valid anchor. The server emits a `warn` of the form `[SessionRotation] No compaction found in <path> (size <X> MB). Forcing bare-bytes-tail rotation...`. Reaching the threshold without a compaction signals the agent has been in a failure loop (every turn 4xx'd before the SDK could write one). The keep-tail is intentionally small: at this size, recent context is almost certainly polluted by error retries; the goal is to unblock cold start, not preserve the failure trail. **If no user-turn entry exists in the kept window, or if a single entry alone exceeds the ~1 MB cap, rotation writes only the new session header** — better to cold-start clean than resume on a dangling tool-pair fragment or a payload that defeats the unblock-cold-start purpose.

Rotation only runs on cold start, before any `SessionManager` is created. During in-process growth, the SDK holds an open reference to the active JSONL file; renaming it mid-run would cause the SDK to recreate the file without a header on the next append.

The `openrouter` provider supports an optional `[llm.api_keys.openrouter.routing]` section that controls upstream provider routing. Keys are model ID prefixes matched against the resolved model (longest prefix wins), values are arrays of OpenRouter provider slugs tried in order. Prefixes containing special characters like `/` must be quoted in TOML (e.g. `"google/" = [...]`). For example, `google = ["google-vertex/global", "google-vertex", "google-ai-studio"]` routes all `google/*` models through Vertex AI first. If no prefix matches, no routing preference is set and OpenRouter uses its default load balancing.

The `openai-compatible` provider requires `base_url` and `model` fields in addition to keys. Use it for self-hosted proxies or providers not listed above. The optional `compat_reasoning` field (default `true`) declares whether the model supports extended thinking. For built-in providers (anthropic, openai, etc.), the SDK already knows which models support reasoning; `compat_reasoning` only applies to `openai-compatible` since the SDK has no way to know the capabilities of an arbitrary endpoint. Setting it to `true` for a model that doesn't support reasoning is safe: the SDK only sends `reasoning_effort` when the provider's compatibility layer confirms support, and most backends ignore unknown parameters.

## Automatic Failover

When API errors occur, System2 automatically retries and fails over:

| Error | Behavior |
|-------|----------|
| **401/403** (auth) | Immediate failover. Key enters 5-minute cooldown. |
| **429** (rate limit) | Retry up to 7x with exponential backoff, then failover. Key enters 90-second cooldown. |
| **500/503/timeout** | Retry 2x with exponential backoff, then failover. Key enters 5-minute cooldown. |
| **400** (bad request) | Immediate failover. Key enters 5-minute cooldown. |

**Failover order:**
1. Next key for the current provider
2. First fallback provider's keys
3. Continue through fallback providers

**Cooldown recovery:** All failures enter a timed cooldown (90 seconds for rate limits, 5 minutes for everything else). Keys become available again automatically after the cooldown expires. All cooldowns are in-memory only; restarting the daemon clears them immediately.

See [Agents](agents.md#authresolver-auth-resolverts) for implementation details.

## Auth Tiers

System2 has two auth tiers:

- **OAuth tier**: subscription credentials (`[llm.oauth]`). Tried first. Three providers are supported as first-class OAuth IDs: `anthropic` (Claude Pro/Max), `openai-codex` (ChatGPT subscription via the Codex CLI flow), and `github-copilot` (Copilot subscription). Any of the three may be used as `primary` or in `fallback`, in any order.
- **API key tier** — `[llm.api_keys].primary` + `fallback`, with per-provider keys nested at `[llm.api_keys.<provider>].keys`. Used after the OAuth tier is fully exhausted (every OAuth credential in cooldown).

The OAuth tier is fully exhausted before the system drops into the API key tier — never interleaving. If `[llm.oauth]` is absent, system2 behaves exactly like an API-key-only setup.

### OAuth subscription support

System2 delegates OAuth provider behavior to pi-ai's provider registry. `getOAuthProvider(id)` returns a small adapter that knows how to run the browser login flow, refresh access tokens, and surface a usable bearer for each of the three providers (`anthropic`, `openai-codex`, `github-copilot`). The agent loop, custom tools, and multi-agent orchestration are unchanged across providers; only the auth path varies. The `[llm.oauth]` shape (`primary` + `fallback`) accepts any of the three provider IDs, in any order.

> **Note:** pi-ai 0.71.0 (2026-04-30) removed `google-gemini-cli` and `google-antigravity` because Google has been disabling user accounts that authenticate via these flows from third-party tools (pi-mono#4017, pi-mono#3999). System2 aligns. If you have legacy `~/.system2/auth/google-{gemini-cli,antigravity}.json` credential files, they are silently ignored at startup; safe to delete.

**Credential shape.** Credentials are written to `~/.system2/auth/<provider>.json` (mode 0600). The `OAuthCredentials` type has an open shape: providers that need extra context store it alongside the access/refresh tokens. Copilot may record an `enterpriseDomain`. These extras are preserved across refreshes.

**Setup:** Run `system2 config` and pick **OAuth providers**, then select one of Anthropic, OpenAI Codex, or GitHub Copilot. The chosen provider's browser flow runs; the resulting tokens are saved to `~/.system2/auth/<provider>.json` and `[llm.oauth]` in `~/.system2/auth/auth.toml` is auto-patched. (On a fresh install, `system2 init` lands you in this menu automatically.)

**Refresh:** OAuth access tokens expire on each provider's own schedule (Anthropic roughly hourly; the others vary). The daemon refreshes them automatically before each agent session creation and on 401 errors. Refreshed tokens are persisted back to the same file.

**Anthropic-specific behavior.** The pi-ai SDK detects Anthropic OAuth tokens (substring match `sk-ant-oat`) and switches the Anthropic client to Bearer auth plus the Claude Code identity headers required by the Pro/Max subscription path. The other providers do not share that path: `openai-codex` posts to the OpenAI Responses API with Codex-CLI-shaped requests, and `github-copilot` hits Copilot's chat completions endpoint, each with its own request shape, headers, and project/enterprise scoping.

**Failover:** A 401 on an OAuth credential triggers one refresh-and-retry. If refresh succeeds, the session reinitializes with the new token and the prompt retries. If refresh fails (or any other error), the OAuth credential enters cooldown and the next OAuth fallback is tried; once the OAuth tier is exhausted, the system drops into the API key tier.

### Model selection

Model selection differs between tiers, reflecting their cost models:

- **OAuth tier (flat-fee subscription)**: one model per provider, used by every agent role. The model is picked from pi-ai's catalog by a family-prefix regex per provider (`claude-opus-*` for Anthropic, `gpt-X.Y[-codex]` for openai-codex, `gpt-X.Y` for github-copilot), so newer flagships propagate automatically when pi-ai bumps. Override with `[llm.oauth.<provider>] model = "..."` to pin a specific model — strictly validated against the catalog at startup.
- **API-keys tier (pay-per-token)**: per-role × per-provider matrix. Defaults come from each agent's frontmatter `api_keys_models:` block (only api-keys-tier providers; OAuth-only providers are intentionally absent). Override per role with `[llm.api_keys.<provider>.models][<role>] = "..."` — also validated at startup.

**Looking up model IDs.** The authoritative list of model IDs available for each provider is pi-ai's catalog: [`packages/ai/src/models.generated.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts) in the pi-mono repo. Use the exact `id` field there when pinning a model in `[llm.oauth.<provider>]` or `[llm.api_keys.<provider>.models]`. Startup validation cross-checks every pin against this catalog and surfaces typos with Levenshtein "did you mean" hints, so a misspelling fails at `system2 start` rather than at the first inference call.

**Auto-fallback on entitlement errors (OAuth tier only).** When a model picked by the family-prefix resolver returns 403 or 404 (typical signals for "model not available on this plan" / "model not found"), the host steps the credential to a hardcoded fallback for the rest of the session and retries once. Defaults today: `claude-sonnet-4-6` for anthropic, `gpt-5.4` for openai-codex, `gpt-4.1` for github-copilot. The fallback fires only when the model came from the resolver — explicit user pins (`[llm.oauth.<provider>] model = "..."`) bubble the error up so misconfiguration surfaces loudly.

**Caveats:**
- Claude Pro/Max usage limits are sized for one human in Claude Code. A multi-agent system2 workload (Guide + Conductor + Reviewer + Workers + Narrator running concurrently) can hit the 5-hour message cap quickly. Configure the API key tier as fallback for sustained workloads.
- Programmatic use of Pro/Max credentials outside Claude Code is in a TOS gray area. Use at your own discretion.
- Prompt caching is disabled on the OAuth path (the SDK strips `cache_control` from system prompts for OAuth tokens). Per-call billing still goes through the subscription.

### Re-authenticating and managing credentials

Use `system2 config` to manage credentials at any time. The command is re-entrant and fully interactive: pick **OAuth providers** from the main menu to see all three OAuth providers (Anthropic, OpenAI Codex, GitHub Copilot) with already-logged-in entries annotated by their position in the failover chain. All credential state lives in `~/.system2/auth/auth.toml` (the auth tier tables) and `~/.system2/auth/<provider>.json` (per-provider OAuth tokens). Behavior depends on the selection:

- **Not yet logged in.** The command runs the provider's browser OAuth flow, writes `~/.system2/auth/<provider>.json`, and (if `[llm.oauth]` is missing or doesn't include the provider) auto-patches `~/.system2/auth/auth.toml` to enable the OAuth tier.
- **Already logged in.** A contextual menu opens: **Re-login** (re-runs the OAuth flow; useful when a refresh token has been invalidated by signing out, password change, revoked grant, or idle-expiry), **Set as primary OAuth provider** (only shown when there's a different primary), **Remove** (deletes `~/.system2/auth/<provider>.json` and removes the provider from `[llm.oauth]`), or **Cancel**. When two or more fallbacks are configured, a **Reorder fallbacks** entry appears in the OAuth submenu.

API-key providers are managed from the **API key providers** submenu with parallel actions (add another key, replace key, set as primary, remove provider, reorder fallbacks). Brave Search lives under **Services**. Esc inside any flow returns to the enclosing submenu without writing anything.

If the daemon is running, restart it to pick up the change: `system2 stop && system2 start`. See [`system2 config`](cli.md#system2-config) in the CLI reference for the full menu structure and cancel/back semantics.

### Changing primary provider or switching auth method

System2 reads both `~/.system2/config.toml` and `~/.system2/auth/auth.toml` only at startup. The path you take depends on what you're changing:

1. **Use `system2 config`** for credentials and credential-adjacent settings: OAuth providers, API keys, primary/fallback ordering on either tier, services (Brave Search), and the `[tools.web_search].enabled` flag. It writes `~/.system2/auth/auth.toml`. Never hand-edit that file: every `system2 config` write rewrites it, so any user-added comments or key reordering are lost.
2. **Edit `~/.system2/config.toml` directly** for everything else: per-agent overrides (`[agents.<role>]`), database connections (`[databases.<name>]`), the `web_search_max_results` scalar, and operational tunables (`[backup]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`, `[session]`, `[delivery]`).
3. Restart the daemon: `system2 stop && system2 start`.

You do not need to switch auth methods manually for cost or rate-limit reasons — the two-tier failover handles that automatically. OAuth is tried first; once exhausted, the system drops to the API key tier without any user action. If a transient failure has put a credential into cooldown and you want to force the system to retry it sooner than the cooldown expiry, restart the daemon (which clears in-memory cooldowns).

## Agent Overrides

Each agent role (guide, conductor, narrator, reviewer, worker) has default settings defined in its library file (`src/server/agents/library/{role}.md`). The `[agents.<role>]` section in config.toml overrides the role's behavior knobs. Model pins live with their tier credentials, not under `[agents.<role>]`.

### Overridable fields under `[agents.<role>]`

| Field | Type | Description |
|-------|------|-------------|
| `thinking_level` | `off`, `minimal`, `low`, `medium`, `high` | Extended-thinking depth for the agent's LLM calls. Tier-agnostic. |
| `compaction_depth` | integer >= 0 | Number of auto-compactions before pruning old context (0 disables). Tier-agnostic. |

All fields are optional. Only specified fields override the library defaults.

Per-role model pins live elsewhere:

- **API-keys tier**: `[llm.api_keys.<provider>.models][<role>]` — see [Model selection](#model-selection).
- **OAuth tier**: one model per provider via `[llm.oauth.<provider>] model = "..."`. The same model applies to every role on that provider.

### Example

In `~/.system2/config.toml`:

```toml
[agents.guide]
thinking_level = "medium"
compaction_depth = 5
```

In `~/.system2/auth/auth.toml` (written by `system2 config`):

```toml
# Per-role model pins (API-keys tier) — keys are role names.
[llm.api_keys.anthropic.models]
narrator = "claude-haiku-4-5-20251001"
guide = "claude-sonnet-4-6"

# OAuth tier — one model for all roles on this provider.
[llm.oauth.anthropic]
model = "claude-opus-4-7"
```

Unknown provider IDs and model IDs are cross-checked against pi-ai's catalog at startup; unknown values throw with did-you-mean suggestions on near-miss typos.

### How it works

During agent initialization, `AgentHost` reads the library frontmatter first, then applies any matching `[agents.<role>]` overrides from `config.toml`. Model resolution branches by the active tier: OAuth picks one model per provider via the resolver (or `[llm.oauth.<p>].model` from `auth.toml`); API-keys reads `[llm.api_keys.<p>.models][<role>]` first (also from `auth.toml`), then frontmatter `api_keys_models[<provider>]`.

## Databases

External database connections are declared as `[databases.<name>]` blocks in config.toml. The name you choose becomes the identifier agents and dashboards use to target that database (for example, the `database` field in the [postMessage bridge](artifacts.md#interactive-dashboards-postmessage-bridge) or the `query_database` tool).

When no database is specified, queries default to `system2`, the internal app.db (SQLite).

### Supported types

| Type | Driver package | Compatible databases |
|------|---------------|---------------------|
| `postgres` | `pg` | PostgreSQL, TimescaleDB, CockroachDB, YugabyteDB, Redshift, AlloyDB, Neon, Supabase |
| `mysql` | `mysql2` | MySQL, MariaDB |
| `sqlite` | `better-sqlite3` | SQLite (opens local file, read-only) |
| `mssql` | `mssql` | SQL Server, Azure SQL |
| `clickhouse` | `@clickhouse/client` | ClickHouse (HTTP protocol) |
| `duckdb` | `duckdb` | DuckDB, MotherDuck (via `md:` prefix) |
| `snowflake` | `snowflake-sdk` | Snowflake |
| `bigquery` | `@google-cloud/bigquery` | Google BigQuery |

More types can be added by implementing a driver adapter.

### Driver installation

Database drivers are not bundled with System2. The Guide installs the required driver packages during onboarding into `~/.system2/node_modules/` based on the database types declared in config.toml. If you add a new database type after onboarding, the Guide will install the missing driver on next startup.

### Credentials

For adapters that use traditional host/user/password connections (postgres, mysql, mssql, clickhouse), passwords can be stored directly in config.toml via the `password` field. Since config.toml is created with `0600` permissions and gitignored, this is safe for personal use. Alternatively, each driver also supports its native credential mechanism as a fallback when no `password` is configured:

| Type | Credential source |
|------|------------------|
| `postgres` | `password` field in config.toml, `~/.pgpass`, or `PGPASSWORD` env var |
| `mysql` | `password` field in config.toml, `~/.my.cnf` `[client]` section, or `MYSQL_PWD` env var |
| `sqlite` | No credentials needed |
| `mssql` | `password` field in config.toml, environment variables (`MSSQL_PASSWORD`), or Azure AD |
| `clickhouse` | `password` field in config.toml, or server-side default credentials |
| `duckdb` | No credentials needed (local files); `MOTHERDUCK_TOKEN` env var for MotherDuck |
| `snowflake` | `SNOWFLAKE_PASSWORD` env var, key-pair via `credentials_file`, or `~/.snowflake/connections.toml` |
| `bigquery` | `credentials_file` (service account JSON), `GOOGLE_APPLICATION_CREDENTIALS` env var, or gcloud ADC |

When the `password` field is omitted, drivers fall back to their native credential mechanisms (env vars, credential files, etc.).

### Configuration fields

**Common fields** (all types):

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | yes | -- | Database type (see supported types table) |
| `database` | yes | -- | Database name, file path (sqlite/duckdb), or dataset (bigquery) |
| `host` | no | `localhost` | Server hostname or IP (postgres, mysql, mssql, clickhouse) |
| `port` | no | Driver default | Server port (postgres: 5432, mysql: 3306, mssql: 1433, clickhouse: 8123) |
| `user` | no | Current OS user | Authentication user |
| `password` | no | -- | Authentication password (postgres, mysql, mssql, clickhouse) |
| `socket` | no | -- | Unix domain socket path, overrides host/port (postgres, mysql) |
| `ssl` | no | `false` | Enable SSL/TLS (postgres, mysql, mssql, clickhouse) |
| `query_timeout` | no | `30` | Query timeout in seconds |
| `max_rows` | no | `10000` | Maximum rows returned per query |

**Snowflake-specific fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `account` | yes | -- | Account identifier (e.g. `xy12345.us-east-1`) |
| `warehouse` | no | -- | Compute warehouse |
| `role` | no | -- | Security role |
| `schema` | no | -- | Default schema |
| `credentials_file` | no | -- | Path to private key file (key-pair auth) |

**BigQuery-specific fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `project` | yes | -- | GCP project ID |
| `credentials_file` | no | -- | Path to service account JSON (falls back to ADC) |

For postgres and mysql, `host`, `port`, `database`, and `user` follow the same semantics as the native client tools (`psql`, `mysql`). For sqlite and duckdb, `database` is the file path. For bigquery, `database` is the dataset name.

### Example configurations

```toml
# PostgreSQL (also works for TimescaleDB, CockroachDB, etc.)
[databases.analytics]
type = "postgres"
database = "analytics"
user = "analyst"

# PostgreSQL: remote server with custom timeout
[databases.warehouse]
type = "postgres"
host = "db.example.com"
port = 5432
database = "warehouse"
user = "readonly"
password = "s3cret"
query_timeout = 60
max_rows = 50000

# MySQL
[databases.legacy]
type = "mysql"
host = "mysql.internal"
port = 3306
database = "legacy_app"
user = "reader"

# SQLite: external database file
[databases.survey_results]
type = "sqlite"
database = "/Users/me/data/survey.db"

# SQL Server
[databases.reporting]
type = "mssql"
host = "sql.example.com"
port = 1433
database = "reporting"
user = "reader"
ssl = true

# ClickHouse
[databases.events]
type = "clickhouse"
host = "clickhouse.internal"
port = 8123
database = "events"
user = "default"

# DuckDB: local file
[databases.parquet_analysis]
type = "duckdb"
database = "/Users/me/data/analysis.duckdb"

# DuckDB: MotherDuck (cloud)
[databases.motherduck]
type = "duckdb"
database = "md:my_database"

# Snowflake
[databases.snowflake_wh]
type = "snowflake"
account = "xy12345.us-east-1"
database = "ANALYTICS"
warehouse = "COMPUTE_WH"
user = "analyst"
role = "ANALYST"
schema = "PUBLIC"

# BigQuery
[databases.bq_analytics]
type = "bigquery"
project = "my-project-123"
database = "my_dataset"
credentials_file = "/path/to/service-account.json"
```

## Application Directory

Config-relevant paths within `~/.system2/` (see [Architecture](architecture.md#runtime-architecture) for the full directory layout):

```
~/.system2/
├── config.toml            # User-edited operational settings (0600)
├── auth/                  # Machine-managed credentials (0700)
│   ├── auth.toml          # Created by `system2 config` (0600)
│   ├── anthropic.json     # OAuth credentials (0600, when present)
│   ├── openai-codex.json
│   └── github-copilot.json
├── app.db                 # SQLite database (gitignored)
├── server.pid             # PID file when server is running
├── sessions/              # Agent JSONL session files (gitignored)
└── logs/                  # Server logs (gitignored)
    ├── system2.log
    └── system2.log.N      # Rotated archives (1-5)
```

Auto-backups: `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`

## See Also

- [CLI](cli.md): `system2 init` creates the config; `system2 config` manages credentials and services
- [Agents](agents.md): how LLM config drives provider selection
- [Knowledge System](knowledge-system.md): knowledge directory details and file size budget
- [Scheduler](scheduler.md): `daily_summary_interval_minutes`
