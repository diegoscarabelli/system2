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

One-shot scaffolder for a fresh install. Creates `~/.system2/` with subdirectories (`sessions/`, `projects/`, `artifacts/`) and writes a fully-commented `config.toml` template (permissions `0600`). On a fresh install it then auto-invokes `system2 config` so first-time users land directly in the credential-management menu, without needing a second command.

Refuses to overwrite an existing install: if `~/.system2/` is already present, `system2 init` prints a friendly message pointing at `system2 config` for re-configuration (and shows how to move the directory aside if you really want to start over). Run it once when first installing System2; afterwards, manage credentials with `system2 config`.

### `system2 config`

Re-entrant top-level menu for credentials and services. Built with [@clack/prompts](https://github.com/bombshell-dev/clack); takes no arguments. Refuses to run while the daemon is up, and refuses to run when `~/.system2/config.toml` is missing (it points at `system2 init` instead).

The main menu has three submenus:

- **OAuth providers** — Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT), GitHub Copilot. Already-logged-in providers are annotated with their position in the failover chain (e.g. `✓ logged in (primary)`, `#2 ✓ logged in`). Per-provider actions: **Re-login** (replace credentials by re-running the browser flow), **Set as primary OAuth provider** (only shown when there's a different primary), **Remove** (delete `~/.system2/oauth/<provider>.json` and drop it from `[llm.oauth]`). Selecting a not-yet-logged-in provider runs the browser OAuth flow and auto-patches `[llm.oauth]`. A **Reorder fallbacks** entry appears when 2+ fallbacks are configured.
- **API key providers** — Anthropic, Cerebras, Google, Groq, Mistral, OpenAI, OpenAI-compatible, OpenRouter, xAI. Per-provider actions: **Add another key** (additional labeled key for rotation), **Replace key**, **Set as primary**, **Remove provider** (drops all keys + the provider from `[llm.api_keys]`). Reorder fallbacks entry mirrors OAuth.
- **Services** — Brave Search: set, replace, or remove the key. The `web_search` tool is auto-enabled when a key is set.

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

The TOML schema is unchanged from previous releases: hand-editing `~/.system2/config.toml` continues to work for advanced tweaks. See [Auth Tiers](configuration.md#auth-tiers) in the configuration reference for how OAuth credentials interact with API key fallback and refresh behavior.

### `system2 start`

Starts the server process.

| Flag | Description |
|------|-------------|
| `-p, --port <number>` | Server port (default: 4242) |
| `--no-browser` | Don't open browser after start |
| `--foreground` | Run in foreground (logs to stdout) |

**Start sequence:**
1. Load and validate `config.toml`
2. Verify at least one tier is configured (`[llm.oauth].primary` or `[llm.api_keys].primary`). If neither is set, prints `No LLM credentials configured. Run \`system2 config\` to set up an OAuth provider or API key provider.` and exits 1 before forking the daemon.
3. Rotate logs if size > 10MB
4. Create automatic backup of `~/.system2/` (24h cooldown, max 3 backups)
5. Check for existing PID file (prevent double-start)
6. Spawn server as detached process (or run in foreground)
7. Write PID file
8. Open browser (unless `--no-browser`)

### `system2 stop`

Reads PID file, sends SIGTERM. Polls for up to 10 seconds, then force-kills with SIGKILL if the process is still running. Cross-platform (uses `taskkill` on Windows).

### `system2 status`

Shows whether the server is running, its PID, log file size, and commands for tailing logs.

## Config Loading (`utils/config.ts`)

The config utility handles:
- Reading and parsing TOML from `~/.system2/config.toml`
- Converting snake_case TOML keys to camelCase TypeScript interfaces
- Deep-merging with defaults (backup cooldown: 24h, max backups: 3, etc.)
- Validating required fields (at least one LLM provider with keys)
- Building a `ServerConfig` object for the server

See [Configuration](configuration.md) for the full config.toml reference.

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
