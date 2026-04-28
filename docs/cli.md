# CLI

Command-line interface for managing the System2 server lifecycle. Provides interactive onboarding, daemon management, and status reporting.

**Source:** `src/cli/`
**Build:** [tsup](https://tsup.egoist.dev/) (part of `pnpm build`)
**Binary:** `system2` (global install via npm)
**Dependencies:** [Commander.js](https://github.com/tj/commander.js), [@clack/prompts](https://github.com/bombshell-dev/clack), [@iarna/toml](https://github.com/iarna/iarna-toml)

## Source Structure

```
src/
├── index.ts               # CLI entry point (Commander setup)
├── commands/
│   ├── onboard.ts         # Interactive setup wizard
│   ├── login.ts           # OAuth login flow (add or refresh credential)
│   ├── logout.ts          # OAuth logout (remove credential)
│   ├── start.ts           # Start server (daemon or foreground)
│   ├── stop.ts            # Graceful shutdown
│   └── status.ts          # Server status info
├── utils/
│   ├── config.ts          # TOML config loading/validation
│   ├── backup.ts          # Auto-backup on start
│   ├── log-rotation.ts    # Log file rotation
│   └── update-notifier.ts # npm update check
└── config/
    └── config.toml        # Template config file
```

## Commands

### `system2 onboard`

Interactive setup wizard using [@clack/prompts](https://github.com/bombshell-dev/clack):

1. Optionally configure the OAuth tier (Claude Pro/Max): runs the browser OAuth flow and writes `~/.system2/oauth/anthropic.json`
2. Select primary LLM provider (Anthropic / Google / OpenAI) and enter API keys (supports multiple labeled keys per provider)
3. Optionally configure fallback provider
4. Optionally configure Brave Search API key
5. Creates `~/.system2/` directory and writes `config.toml` (permissions `0600`)

At least one auth tier (OAuth or API key) must be configured. The OAuth step comes first and is independent: you can configure OAuth only, API keys only, or both.

### `system2 login [provider]`

Runs the OAuth flow for `provider` (default: `anthropic`, the only supported provider in v1), writes the resulting tokens to `~/.system2/oauth/<provider>.json` (mode 0600), and offers to patch `[llm.oauth]` in `config.toml` if the provider is not already there.

Use this command to:
- Add OAuth credentials after onboarding (if you skipped the OAuth step).
- Re-authenticate when a refresh token has been invalidated — for example after signing out of Claude.ai, changing your password, revoking the app's grant, or hitting an idle expiry on the refresh token.

After running `system2 login`, restart the daemon to pick up the new credential:

```bash
system2 stop && system2 start
```

See [Auth Tiers](../configuration.md#auth-tiers) in the configuration reference for how OAuth credentials interact with API key fallback and refresh behavior.

### `system2 logout [provider]`

Removes the OAuth credential for `provider` (default: `anthropic`). The command:
1. Asks for confirmation, then deletes `~/.system2/oauth/<provider>.json`.
2. Offers to remove `provider` from `[llm.oauth]` in `config.toml`.

If `[llm.oauth]` becomes empty (the last provider is removed), the entire section is dropped from `config.toml`, and system2 reverts to API-key-only behavior on next start.

After running `system2 logout`, restart the daemon to apply the change:

```bash
system2 stop && system2 start
```

### `system2 start`

Starts the server process.

| Flag | Description |
|------|-------------|
| `-p, --port <number>` | Server port (default: 4242) |
| `--no-browser` | Don't open browser after start |
| `--foreground` | Run in foreground (logs to stdout) |

**Start sequence:**
1. Load and validate `config.toml`
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
- Reading and parsing TOML from `~/.system2/config.toml`
- Converting snake_case TOML keys to camelCase TypeScript interfaces
- Deep-merging with defaults (backup cooldown: 24h, max backups: 3, etc.)
- Validating required fields (at least one LLM provider with keys)
- Building a `ServerConfig` object for the server

See [Configuration](../configuration.md) for the full config.toml reference.

## Utilities

### Auto-Backup (`utils/backup.ts`)

On every `system2 start`, creates a timestamped copy of `~/.system2/` at `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`. Skipped if the last backup is less than `cooldown_hours` old. Old backups are pruned to keep at most `max_backups`.

### Log Rotation (`utils/log-rotation.ts`)

Rotates `~/.system2/logs/system2.log` when it exceeds the configured threshold (default 10MB). Archived files are named `system2.log.1` through `system2.log.N`.

### Update Notifier (`utils/update-notifier.ts`)

On every CLI invocation, checks whether a newer version of `@diegoscarabelli/system2` is available on npm and prints a one-line notice with the update command. The check is non-blocking: a cached result from the previous run is displayed immediately, and a background fetch refreshes the cache for next time (1h interval). All errors are silently ignored (offline, package not published, pre-onboarding).

## See Also

- [Server](server.md): the server this CLI manages
- [Configuration](../configuration.md): config.toml format and defaults
