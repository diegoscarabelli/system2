/**
 * Update Notifier
 *
 * Checks the npm registry for newer versions of System2 and prints a
 * one-line notice when the installed version is outdated.
 *
 * Design:
 * - On each CLI invocation, reads a local cache (~/.system2/update-check.json).
 * - If the cache contains a newer version, prints the update notice immediately.
 * - Then kicks off a background fetch (not awaited) to refresh the cache for
 *   next time. This keeps the CLI startup fast: the user never waits on a
 *   network call.
 * - All errors are silently swallowed (offline, not published, no ~/.system2).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM2_DIR } from './config.js';

const CACHE_FILE = join(SYSTEM2_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REGISTRY_URL = 'https://registry.npmjs.org/@diegoscarabelli/system2/latest';
const PACKAGE_NAME = '@diegoscarabelli/system2';

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

/** Compare two semver strings (major.minor.patch). Returns true if b > a. */
export function isNewer(current: string, latest: string): boolean {
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

function readCache(): UpdateCache | undefined {
  try {
    if (!existsSync(CACHE_FILE)) return undefined;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as UpdateCache;
  } catch {
    return undefined;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch {
    // ~/.system2 may not exist yet (pre-onboarding)
  }
}

export async function fetchLatestVersion(
  fetchFn: typeof fetch = fetch
): Promise<string | undefined> {
  try {
    const res = await fetchFn(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch {
    return undefined;
  }
}

/** Refresh the cache in the background (fire-and-forget). */
function refreshCache(fetchFn: typeof fetch = fetch): void {
  fetchLatestVersion(fetchFn).then((version) => {
    if (version) {
      writeCache({ lastCheck: Date.now(), latestVersion: version });
    }
  });
}

/**
 * Check for updates and print a notice if one is available.
 *
 * Call this once at CLI startup. It reads the cache synchronously,
 * prints a message if needed, and kicks off a non-blocking background
 * refresh.
 */
export function checkForUpdates(currentVersion: string, fetchFn: typeof fetch = fetch): void {
  try {
    const cache = readCache();

    // Show notice from previous check
    if (cache && isNewer(currentVersion, cache.latestVersion)) {
      console.log(
        `\n  Update available: ${currentVersion} → ${cache.latestVersion}` +
          `\n  Run: pnpm update -g ${PACKAGE_NAME}\n`
      );
    }

    // Refresh cache if stale (or missing)
    if (!cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS) {
      refreshCache(fetchFn);
    }
  } catch {
    // Never let update checks break the CLI
  }
}
