# CLI

Command-line interface for managing the System2 server lifecycle. Provides install scaffolding, interactive credential management, daemon management, and status reporting.

**Source:** `src/cli/`
**Build:** [tsup](https://tsup.egoist.dev/) (part of `pnpm build`)
**Binary:** `system2` (global install via npm)
**Dependencies:** [Commander.js](https://github.com/tj/commander.js), [@clack/prompts](https://github.com/bombshell-dev/clack), [@iarna/toml](https://github.com/iarna/iarna-toml)

## Source Structure

```
src/
├── index.ts               # CLI entry point (Commander setup)
├── commands/
│   ├── init.ts            # Scaffolds ~/.system2 and hands off to config
│   ├── config.ts          # Re-entrant credential/services menu
│   ├── start.ts           # Start server (daemon or foreground)
│   ├── stop.ts            # Graceful shutdown
│   └── status.ts          # Server status info
├── utils/
│   ├── config.ts          # TOML config loading/validation
│   ├── toml-patchers.ts   # Targeted TOML edits used by `system2 config`
│   ├── oauth-format.ts    # OAuth instruction formatting
│   ├── backup.ts          # Auto-backup on start
│   ├── log-rotation.ts    # Log file rotation
│   └── update-notifier.ts # npm update check
└── config/
    └── config.toml        # Template config file
```

## Commands

### `system2 init`

One-shot scaffolder for a fresh install. Creates `~/.system2/` with subdirectories (`sessions/`, `projects/`, `artifacts/`, and `auth/` at `0700`) and writes a fully-commented `config.toml` template (permissions `0600`) containing operational settings only — no auth sections. Does NOT create `.auth.toml`; that file is written by `system2 config` on first credential save. On a fresh install it then auto-invokes `system2 config` so first-time users land directly in the credential-management menu, without needing a second command.

Idempotent on re-run: invoking `system2 init` against an existing install does NOT clobber `.auth.toml` or any credentials under `auth/`. This makes the config-recovery flow safe — `mv ~/.system2/config.toml ~/.system2/config.toml.bak && system2 init` regenerates a clean `config.toml` while preserving all auth state. Run it once when first installing System2; afterwards, manage credentials with `system2 config`.

### `system2 config`

Re-entrant top-level menu for credentials and services. Built with [@clack/prompts](https://github.com/bombshell-dev/clack); takes no arguments. Refuses to run while the daemon is up, and refuses to run when `~/.system2/config.toml` is missing (it points at `system2 init` instead).

Reads and writes ONLY `~/.system2/auth/.auth.toml` (the credentials file written by `system2 config`); it never touches `config.toml`. On the first credential write it creates `.auth.toml` with permissions `0600` and a header comment: `# Managed by 'system2 config' — do not edit by hand.`. OAuth credential JSON files live alongside it under `~/.system2/auth/<provider>.json` (also `0600`).

The main menu has three submenus:

- **OAuth providers** — Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT), GitHub Copilot. Already-logged-in providers are annotated with their position in the failover chain (e.g. `✓ logged in (primary)`, `#2 ✓ logged in`). Per-provider actions: **Re-login** (replace credentials by re-running the browser flow), **Set as primary OAuth provider** (only shown when there's a different primary), **Remove** (delete `~/.system2/auth/<provider>.json` and drop it from `[llm.oauth]` in `.auth.toml`). Selecting a not-yet-logged-in provider runs the browser OAuth flow and auto-patches `[llm.oauth]` in `.auth.toml`. A **Reorder fallbacks** entry appears when 2+ fallbacks are configured.
- **API key providers** — Anthropic, Cerebras, Google, Groq, Mistral, OpenAI, OpenAI-compatible, OpenRouter, xAI. Per-provider actions: **Add another key** (additional labeled key for rotation), **Replace key**, **Set as primary**, **Remove provider** (drops all keys + the provider from `[llm.api_keys]` in `.auth.toml`). Reorder fallbacks entry mirrors OAuth.
- **Services** — Brave Search: set, replace, or remove the key. The `web_search` tool is auto-enabled when a key is set (the `web_search.enabled` flag lives in `.auth.toml`; the `web_search_max_results` operational scalar lives in `config.toml`).

**Cancel/back semantics.** Esc at the main menu exits cleanly. Esc inside a submenu (or the explicit `Back to main menu` entry) returns to the main menu. Inside a data-entry flow, Esc or empty submission on a required prompt returns to the enclosing submenu without writing anything; there is no global exit from inside a flow, and no infinite "API key is required" loop on empty input.

Use this command to:
- Add an LLM credential after `system2 init` (the post-init hand-off lands you here automatically).
- Add additional OAuth providers or API-key providers, or rotate / replace existing keys.
- Re-authenticate after a refresh token has been invalidated (sign-out, password change, revoked grant, idle expiry).
- Remove a credential entirely.
- Configure or remove the Brave Search service key.

The daemon must be stopped before running it; restart afterward to pick up the change:

```bash
system2 stop && system2 config && system2 start
```

Don't hand-edit `.auth.toml`: every `system2 config` invocation rewrites the file from scratch (comments and key order are not preserved), so any manual edits would silently disappear on the next run. The leading dot in the filename is intentional too: it hides the file from `ls` (without `-a`) and from most editor file pickers, reinforcing the "managed by tooling" signal. For operational settings (agents, databases, scheduler, the `web_search_max_results` scalar, etc.) hand-edit `~/.system2/config.toml`; the daemon reads `config.toml` but never writes it. See [Auth Tiers](configuration.md#auth-tiers) in the configuration reference for how OAuth credentials interact with API key fallback and refresh behavior.

### `system2 start`

Starts the server process.

| Flag | Description |
|------|-------------|
| `-p, --port <number>` | Server port (default: 4242) |
| `--no-browser` | Don't open browser after start |
| `--foreground` | Run in foreground (logs to stdout) |

**Start sequence:**
1. Load and validate `config.toml` and `auth/.auth.toml`, then run a four-state credential probe:
   - `not_initialized` — `config.toml` is missing. Prints a message pointing at `system2 init` and exits 1.
   - `malformed { file: 'config' }` — `config.toml` exists but fails to parse. Prints `Fix syntax in ~/.system2/config.toml` and exits 1.
   - `missing` — `config.toml` is OK but `.auth.toml` is missing or has no primary in either tier (`[llm.oauth].primary` / `[llm.api_keys].primary`). Prints `No LLM credentials configured. Run \`system2 config\` to set up an OAuth provider or API key provider.` and exits 1.
   - `malformed { file: 'auth' }` — `.auth.toml` exists but fails to parse. Prints `Fix syntax in ~/.system2/auth/.auth.toml or run \`system2 config\` to reset it.` and exits 1.
   - `configured` — both files load cleanly and a primary is set in at least one tier. Proceed.
2. Rotate logs if size > 10MB
3. Create automatic backup of `~/.system2/` (24h cooldown, max 3 backups)
4. Check for existing PID file (prevent double-start)
5. Spawn server as detached process (or run in foreground)
6. Write PID file
7. Open browser (unless `--no-browser`)

### `system2 stop`

Reads PID file, sends SIGTERM. Polls for up to 10 seconds, then force-kills with SIGKILL if the process is still running. Cross-platform (uses `taskkill` on Windows).

### `system2 status`

Shows whether the server is running, its PID, log file size, and commands for tailing logs.

## Config Loading (`utils/config.ts`)

The config utility handles:
- Reading and parsing TOML from `~/.system2/config.toml` (operational settings) and `~/.system2/auth/.auth.toml` (credentials)
- Converting snake_case TOML keys to camelCase TypeScript interfaces
- Deep-merging with defaults (backup cooldown: 24h, max backups: 3, etc.)
- Running the four-state credential probe described under [`system2 start`](#system2-start) (file-specific `not_initialized` / `malformed` / `missing` / `configured` results)
- Building a `ServerConfig` object for the server (with credentials from `.auth.toml` overlaid onto operational config)

See [Configuration](configuration.md) for the full reference on both files.

## Utilities

### Auto-Backup (`utils/backup.ts`)

On every `system2 start`, creates a timestamped copy of `~/.system2/` at `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`. Skipped if the last backup is less than `cooldown_hours` old. Old backups are pruned to keep at most `max_backups`.

### Log Rotation (`utils/log-rotation.ts`)

Rotates `~/.system2/logs/system2.log` when it exceeds the configured threshold (default 10MB). Archived files are named `system2.log.1` through `system2.log.N`.

### Update Notifier (`utils/update-notifier.ts`)

On every CLI invocation, checks whether a newer version of `@diegoscarabelli/system2` is available on npm and prints a one-line notice with the update command. The check is non-blocking: a cached result from the previous run is displayed immediately, and a background fetch refreshes the cache for next time (1h interval). All errors are silently ignored (offline, package not published, pre-init).

## See Also

- [Server](server.md): the server this CLI manages
- [Configuration](configuration.md): config.toml format and defaults
