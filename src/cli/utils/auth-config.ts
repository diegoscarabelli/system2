/**
 * Auth Configuration
 *
 * Manages `~/.system2/auth/auth.toml`: the machine-managed file that holds
 * LLM credentials (OAuth + API keys), services (Brave Search), and the
 * web_search.enabled flag. Edited exclusively by `system2 config`; never
 * touched by `system2 init` or hand-edited by the user.
 *
 * Companion file to `config.toml` (user-edited operational settings). The
 * filesystem split (separate file under a 0o700 dir) lets us round-trip via
 * plain TOML.parse → mutate → TOML.stringify, since there are no user
 * comments to preserve. Replaces ~1100 lines of regex patchers in 0.2.x.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import TOML from '@iarna/toml';
import { AUTH_DIRNAME } from '../../shared/index.js';

// Re-export so existing CLI consumers (and the rename-rather-than-rewrite
// path in `src/cli/commands/init.ts`) keep importing it from auth-config.
export { AUTH_DIRNAME };

/**
 * On-disk shape of `auth.toml`. Distinct from the in-memory `System2Config`
 * the loader composes: this is just the auth-owned subset of fields.
 *
 * Provider sub-keys (`anthropic`, `openai`, etc.) are typed loosely as
 * `Record<string, unknown>` because each provider has slightly different
 * shape (some have `keys`, some have `routing`, openai-compatible has
 * `base_url`/`model`). The patcher functions narrow them at the use site.
 */
export interface AuthToml {
  llm?: {
    oauth?: {
      primary?: string;
      fallback?: string[];
      // Per-provider OAuth model pins live here as sibling tables.
      [providerOrField: string]: unknown;
    };
    api_keys?: {
      primary?: string;
      fallback?: string[];
      // Per-provider API-key sub-tables (keys array, optional extras) live here.
      [providerOrField: string]: unknown;
    };
  };
  services?: {
    brave_search?: { key?: string };
  };
  tools?: {
    web_search?: { enabled?: boolean };
  };
}

export const AUTH_FILENAME = 'auth.toml';

/** Header comment prepended on every write, signalling machine-managed. */
const AUTH_HEADER =
  "# Managed by 'system2 config' — do not edit by hand.\n# Comments and key order are not preserved across writes.\n\n";

export function authDir(system2Dir: string): string {
  return join(system2Dir, AUTH_DIRNAME);
}

export function authFile(system2Dir: string): string {
  return join(authDir(system2Dir), AUTH_FILENAME);
}

/**
 * Ensure the auth directory exists with 0o700 permissions. Idempotent on
 * existing dirs (re-applies the chmod to defend against loose perms on a
 * hand-modified install). No-op for the chmod on Windows.
 */
export function ensureAuthDir(system2Dir: string): void {
  const dir = authDir(system2Dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700);
  }
}

/**
 * Read and parse auth.toml. Returns an empty object when the file does not
 * exist (the post-init pre-config state) so callers don't need to special-case
 * the missing-file path. Throws on TOML parse errors so the user sees the
 * malformed-file message instead of silently falling back to defaults.
 */
export function loadAuthToml(authPath: string): AuthToml {
  if (!existsSync(authPath)) return {};
  const raw = readFileSync(authPath, 'utf-8');
  return TOML.parse(raw) as AuthToml;
}

/**
 * Atomically write auth.toml. Creates the parent dir if missing (with 0o700),
 * stringifies via @iarna/toml, prepends the header comment, and writes via
 * tmp-rename so partial writes can't leave a corrupt file.
 *
 * Windows note: rename across same-filesystem with an existing destination
 * works on NTFS via Node 14+, but historically pi-ai's saveOAuthCredentials
 * uses a direct write fallback. Mirror that here.
 */
export function saveAuthToml(authPath: string, auth: AuthToml): void {
  const parent = dirname(authPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    chmodSync(parent, 0o700);
  }

  // @iarna/toml's stringify rejects undefined and empty top-level objects.
  // Strip empty branches before serializing so we never write `[llm]` with
  // no contents.
  const cleaned = pruneEmpty(auth as Record<string, unknown>);
  const body = Object.keys(cleaned).length === 0 ? '' : TOML.stringify(cleaned as never);
  const data = AUTH_HEADER + body;

  if (process.platform === 'win32') {
    writeFileSync(authPath, data, { mode: 0o600 });
    return;
  }

  const tmp = `${authPath}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, authPath);
}

/**
 * Read → parse → mutate → stringify → write. The single helper that powers
 * every auth.toml patcher.
 *
 * The mutator is given the parsed object (or `{}` when the file doesn't yet
 * exist) and is free to mutate it in place. After the mutator returns, the
 * (possibly modified) object is serialized and written atomically. Errors
 * inside the mutator propagate out without writing — file is unchanged on
 * any thrown exception.
 */
export function withAuth(authPath: string, mutate: (auth: AuthToml) => void): void {
  const auth = loadAuthToml(authPath);
  mutate(auth);
  saveAuthToml(authPath, auth);
}

/**
 * Recursively drop keys whose value is undefined or an object with no
 * remaining keys. Keeps the on-disk file from accumulating empty `[llm]`,
 * `[llm.api_keys]`, etc. tables after a remove operation empties them out.
 */
function pruneEmpty<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      out[k] = v;
      continue;
    }
    if (typeof v === 'object') {
      const pruned = pruneEmpty(v as Record<string, unknown>);
      if (Object.keys(pruned).length === 0) continue;
      out[k] = pruned;
      continue;
    }
    out[k] = v;
  }
  return out as T;
}
