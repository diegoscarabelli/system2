/**
 * Timestamped logger that prepends ISO timestamps to all output.
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log.info('[Server] started');   // 2026-03-26T14:30:05.123Z [Server] started
 *   log.error('[Server] fail:', e); // 2026-03-26T14:30:05.456Z [Server] fail: Error: ...
 */

export const log = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), ...args),
};
