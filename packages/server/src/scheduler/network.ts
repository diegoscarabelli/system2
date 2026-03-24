/**
 * Network Connectivity Check
 *
 * Lightweight DNS-based check used by scheduled jobs to skip execution
 * when the network is unreachable (e.g. laptop lid closed during Power Nap).
 * Prevents JSONL session bloat from failed API calls and empty assistant turns.
 */

import { resolve } from 'node:dns/promises';

/**
 * Check whether the network is reachable via a DNS lookup.
 *
 * Uses `dns.google` (Google Public DNS) as the probe target.
 * Returns false if DNS resolution fails or exceeds the timeout.
 *
 * @param timeoutMs Maximum time to wait for DNS resolution (default: 3000ms)
 */
export async function isNetworkAvailable(timeoutMs = 3000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      resolve('dns.google'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
