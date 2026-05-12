/**
 * Shell Tool
 *
 * Executes shell commands with streaming output, background execution,
 * and proper AbortSignal handling. Uses PowerShell on Windows, default
 * shell (bash) on macOS/Linux.
 *
 * Supports a heartbeat protocol for long-running commands: scripts can
 * emit `::system2:: <message>` lines on stdout to reset the inactivity
 * timer and push progress updates to the UI.
 *
 * Large-output handling: when stdout+stderr exceeds the inline cap
 * (default 128 KB, configurable), the full output is saved to a file
 * under `<sessionDir>/bash-output/<toolCallId>.log` and the tool returns
 * head + tail previews plus the file path. The agent can then use the
 * `read` tool with offset/limit (or rerun bash with grep/tail/sed) to
 * inspect specific slices on demand.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import { DEFAULT_BASH_MAX_INLINE_OUTPUT_BYTES } from '../../../shared/index.js';
import { log } from '../../utils/logger.js';

const LEGACY_TIMEOUT = 120_000; // 120s fixed timeout (backward compat when no timeout params given)
const DEFAULT_INACTIVITY_TIMEOUT = 60_000; // 60 seconds
const DEFAULT_TOTAL_TIMEOUT = 600_000; // 10 minutes
const MIN_TIMEOUT = 10_000; // 10 seconds
const MAX_TIMEOUT = 600_000; // 10 minutes

/** Hard upper bound on bytes accepted FROM a single command's stdout/stderr
 *  streams. Anything past this is dropped during streaming (runaway-process
 *  guard). Separate from MAX_INLINE_OUTPUT_BYTES: that one decides what's
 *  shown to the model inline vs. saved to a file; this one bounds what's
 *  ever captured in the first place. */
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/** Bytes from the start of large output included verbatim in the inline preview. */
const PREVIEW_HEAD_BYTES = 8 * 1024;

/** Bytes from the end of large output included verbatim in the inline preview. */
const PREVIEW_TAIL_BYTES = 2 * 1024;

/** Per-agent subdirectory under the session dir where large bash outputs are saved. */
const BASH_OUTPUT_SUBDIR = 'bash-output';

/** Sentinel pattern: lines matching `::system2:: <message>` are heartbeats. */
export const HEARTBEAT_RE = /^::system2::\s*(.*)$/;

/** Patterns that are always blocked: catastrophic, essentially irreversible operations. */
export const BLOCKED_BASH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\brm\b[^;|&]*(--recursive|-[a-zA-Z]*[rR])[^;|&]*\s+\/(\s|$|\*)/,
    reason: 'Recursive deletion of root directory (/) is blocked',
  },
  {
    pattern: /\brm\b[^;|&]*(--recursive|-[a-zA-Z]*[rR])[^;|&]*\s+~\/?(\s|$|\*)/,
    reason: 'Recursive deletion of home directory (~) is blocked',
  },
  {
    pattern:
      /\brm\b[^;|&]*(--recursive|-[a-zA-Z]*[rR])[^;|&]*\s+"?(?:\$HOME|\$\{HOME\})\/?"?(\s|$|\*)/,
    reason: 'Recursive deletion of home directory ($HOME) is blocked',
  },
  {
    pattern: /--no-preserve-root/,
    reason: 'The --no-preserve-root flag is blocked',
  },
  {
    pattern: /\bmkfs\b/,
    reason: 'Formatting filesystems (mkfs) is blocked',
  },
  {
    pattern: /\bdd\b[^;|&]*\bof\s*=\s*["']?\/dev\//,
    reason: 'Writing to raw block devices (dd of=/dev/) is blocked',
  },
  {
    pattern: /\bsqlite3\b[^;|&]*\.system2[/\\]app\.db/,
    reason: 'Direct sqlite3 access to app.db is blocked — use write_system2_db instead',
  },
];

// On Windows, use PowerShell instead of cmd.exe for better scripting support
const isWindows = platform() === 'win32';
const shellCmd = isWindows ? 'powershell.exe' : '/bin/bash';

type NotifyBackground = (content: string, details: unknown) => void;

interface BashDetails {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  background?: boolean;
  command?: string;
  heartbeat?: boolean;
  heartbeatMessage?: string;
}

/**
 * Filter heartbeat sentinel lines from a stdout chunk.
 * Returns the filtered text (sentinels removed) and any heartbeat messages found.
 */
export function filterHeartbeats(text: string): {
  filtered: string;
  heartbeats: string[];
} {
  // Normalize Windows \r\n to \n so the sentinel regex matches cleanly
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  const heartbeats: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = HEARTBEAT_RE.exec(lines[i]);
    if (match) {
      heartbeats.push(match[1].trim());
    } else {
      kept.push(lines[i]);
    }
  }

  return { filtered: kept.join('\n'), heartbeats };
}

/** Clamp a value between min and max. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Run a command via spawn, collect output, stream via onUpdate, respect AbortSignal.
 * Uses dual timeouts: inactivity (resets on output) and total (hard cap).
 */
function runCommand(
  command: string,
  cwd: string,
  inactivityTimeout: number,
  totalTimeout: number,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<BashDetails>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = isWindows ? ['-Command', command] : ['-c', command];
    const child = spawn(shellCmd, args, { cwd, env: process.env });

    let stdout = '';
    let stderr = '';
    // Track running UTF-8 byte counts so MAX_BUFFER enforces on bytes (its
    // documented unit) rather than UTF-16 code units. `stdout.length` would
    // undercount for non-ASCII content (each non-BMP codepoint is 2 UTF-16
    // code units but 4 UTF-8 bytes, multi-byte BMP chars are 1 code unit but
    // 2-3 UTF-8 bytes). Computing `Buffer.byteLength(stdout, 'utf8')` per
    // chunk would be O(n²) total over the whole stream, so we maintain the
    // running count incrementally — each chunk's byte length is computed
    // once and added.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (totalTimer) clearTimeout(totalTimer);
    };

    const settle = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (settled) return;
      settled = true;
      clearTimers();
      cleanup();
      resolve(result);
    };

    const fail = (error: Error & { stdout?: string; stderr?: string; exitCode?: number }) => {
      if (settled) return;
      settled = true;
      clearTimers();
      cleanup();
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    // AbortSignal handling
    const onAbort = () => {
      child.kill('SIGTERM');
      const err = new Error('Command aborted') as Error & { exitCode?: number };
      err.exitCode = 130;
      fail(err);
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      child.kill('SIGTERM');
      const err = new Error('Command aborted') as Error & { exitCode?: number };
      err.exitCode = 130;
      reject(err);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    // Reset the inactivity timer (called on every stdout/stderr data event)
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        child.kill('SIGTERM');
        const err = new Error(
          `Command timed out after ${inactivityTimeout / 1000}s of inactivity`
        ) as Error & { exitCode?: number };
        err.exitCode = 124;
        fail(err);
      }, inactivityTimeout);
    };

    // Start both timers
    resetInactivityTimer();
    totalTimer = setTimeout(() => {
      child.kill('SIGTERM');
      const err = new Error(
        `Command exceeded total timeout of ${totalTimeout / 1000}s`
      ) as Error & { exitCode?: number };
      err.exitCode = 124;
      fail(err);
    }, totalTimeout);

    // Buffer for incomplete lines across chunks (sentinel may be split across data events)
    let pendingLine = '';

    // Collect and stream output
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = pendingLine + chunk.toString();
      pendingLine = '';
      resetInactivityTimer();

      // Only process complete lines; hold the trailing fragment for the next chunk
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        // No newline at all: entire chunk is a partial line, buffer it
        pendingLine = text;
        return;
      }
      const complete = text.slice(0, lastNewline + 1); // includes trailing \n
      pendingLine = text.slice(lastNewline + 1); // remainder (may be empty)

      // Filter heartbeat sentinel lines
      const { filtered, heartbeats } = filterHeartbeats(complete);

      if (filtered) {
        const filteredBytes = Buffer.byteLength(filtered, 'utf8');
        if (stdoutBytes + filteredBytes <= MAX_BUFFER) {
          stdout += filtered;
          stdoutBytes += filteredBytes;
        }
      }

      // Emit heartbeat progress updates (minimal payload: only details matter)
      for (const message of heartbeats) {
        onUpdate?.({
          content: [{ type: 'text', text: '' }],
          details: {
            stdout: '',
            stderr: '',
            exitCode: -1,
            heartbeat: true,
            heartbeatMessage: message,
          },
        });
      }

      // Regular streaming update (only if there was non-heartbeat content)
      if (filtered) {
        onUpdate?.({
          content: [{ type: 'text', text: stdout + (stderr ? `\nSTDERR:\n${stderr}` : '') }],
          details: { stdout, stderr, exitCode: -1 },
        });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      resetInactivityTimer();
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (stderrBytes + textBytes <= MAX_BUFFER) {
        stderr += text;
        stderrBytes += textBytes;
      }
      onUpdate?.({
        content: [{ type: 'text', text: stdout + (stderr ? `\nSTDERR:\n${stderr}` : '') }],
        details: { stdout, stderr, exitCode: -1 },
      });
    });

    child.on('close', (code) => {
      // Flush any remaining partial line from the buffer
      if (pendingLine) {
        const { filtered } = filterHeartbeats(pendingLine);
        if (filtered) {
          const filteredBytes = Buffer.byteLength(filtered, 'utf8');
          if (stdoutBytes + filteredBytes <= MAX_BUFFER) {
            stdout += filtered;
            stdoutBytes += filteredBytes;
          }
        }
        pendingLine = '';
      }
      settle({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      fail(err as Error & { exitCode?: number });
    });
  });
}

export interface BashToolOptions {
  /** Where to persist large output files. When undefined (e.g. in tests), the
   *  cap still applies but output is truncated in place without a file save. */
  sessionDir?: string;
  /** Override the inline byte cap. Defaults to DEFAULT_BASH_MAX_INLINE_OUTPUT_BYTES. */
  maxInlineOutputBytes?: number;
}

/** Result of capOutputForInline: the string to feed back into the model and,
 *  when output was saved, the absolute path to the saved file (so callers can
 *  also shrink the persisted `details.stdout/stderr` to a marker instead of
 *  re-storing the same bytes in the JSONL). */
export interface CappedOutput {
  inline: string;
  savedPath: string | null;
  totalBytes: number;
}

/** Count lines in `s` using `wc -l`-compatible semantics:
 *    - empty string → 0
 *    - count `\n` occurrences
 *    - add 1 if the string does NOT end in `\n` (last line is partial)
 *  Examples:
 *    countLines("")        === 0
 *    countLines("a")       === 1   // partial line, no trailing newline
 *    countLines("a\n")     === 1   // exactly one terminated line
 *    countLines("a\nb")    === 2   // one terminated + one partial
 *    countLines("a\nb\n")  === 2
 *  Avoids `split('\n')` which would allocate an N-element array on near-
 *  MAX_BUFFER outputs. */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 0;
  let i = -1;
  // biome-ignore lint/suspicious/noAssignInExpressions: tight loop, standard scan pattern
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
  // Trailing partial line (no `\n` after the last character).
  if (!s.endsWith('\n')) n++;
  return n;
}

/** Return the longest prefix of `s` whose UTF-8 encoding is at most `budgetBytes`.
 *  Binary search over code-unit length: O(log n × n) on Buffer.byteLength, but
 *  bounded by the input length and only invoked when we know the prefix is
 *  oversized. Used by the cap code so preview byte budgets are honored even
 *  for non-ASCII output (where `s.length` and `Buffer.byteLength` diverge). */
function takeFirstNBytes(s: string, budgetBytes: number): string {
  if (budgetBytes <= 0 || s.length === 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= budgetBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= budgetBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Mirror of `takeFirstNBytes` for the suffix of `s`. */
function takeLastNBytes(s: string, budgetBytes: number): string {
  if (budgetBytes <= 0 || s.length === 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= budgetBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(s.slice(-mid), 'utf8') <= budgetBytes) lo = mid;
    else hi = mid - 1;
  }
  // Critical: JS treats `slice(-0)` as `slice(0)`, returning the WHOLE string.
  // If the search bottomed out at `lo === 0` (every single character's UTF-8
  // bytes already exceed the budget), the only correct return is the empty
  // string — anything else violates the byte budget AND causes the final-
  // guard shrink loop in `capOutputForInline` to spin forever (tail never
  // shrinks below a single multi-byte character).
  if (lo === 0) return '';
  return s.slice(-lo);
}

/** Coerce `toolCallId` to a filesystem-safe basename. Defense-in-depth:
 *  Anthropic's tool-call ids are alphanumeric `toolu_…`, but a future
 *  provider or a hostile spoof could feed a value containing `/` or `..`
 *  that would let writeFile escape `<sessionDir>/bash-output`. Strip to a
 *  whitelist after taking `basename` (which already drops `/` segments). */
function safeOutputFilename(toolCallId: string): string {
  const base = basename(toolCallId).replace(/[^A-Za-z0-9_-]/g, '_');
  return base.length > 0 ? `${base}.log` : 'bash-output.log';
}

/**
 * Cap inline tool output. If the output's UTF-8 byte size exceeds
 * `maxInlineBytes` and `sessionDir` is available, write the full output to
 * `<sessionDir>/bash-output/<safeOutputFilename(toolCallId)>` and return a
 * string containing a header pointer + head/tail previews + a "[...N bytes
 * truncated...]" marker between them. If `sessionDir` is absent or the file
 * write fails, truncate without saving (best-effort).
 *
 * Byte accounting uses `Buffer.byteLength(..., 'utf8')` rather than
 * `string.length` (which counts UTF-16 code units): for non-ASCII output the
 * two diverge, and the cap is documented as a byte cap. Preview slicing uses
 * `takeFirstNBytes` / `takeLastNBytes`, which binary-search for the longest
 * code-unit prefix/suffix that fits the byte budget — so each preview is
 * byte-bounded even on heavily non-ASCII output.
 *
 * Layout & cap enforcement:
 *   - Initial preview budget is `maxInlineBytes - HEADER_OVERHEAD_BYTES` (512).
 *     This is a starting reservation; the actual header (`savedPath`, locale-
 *     formatted byte/line counts, guidance text) may be larger or smaller.
 *   - After the initial render, a final-guard loop checks the rendered string's
 *     UTF-8 byte length. If it exceeds `maxInlineBytes` (e.g. an unusually long
 *     savedPath consumed more than 512 bytes of the budget), the loop halves
 *     `head` then `tail` until the payload fits, falling back to header-only
 *     if even an empty preview would overflow.
 *   - 80/20 split between head and tail (head is more useful for diagnostics).
 *   - If the preview budget is <= 0 the function emits a header-only payload.
 *     The CLI validator enforces maxInlineBytes >= 4 KB so this is a defensive
 *     branch, not a routine path.
 *
 * I/O is async (fs.promises.mkdir + writeFile) so that a 10 MB write does
 * not block Node's event loop during multi-agent concurrent tool execution.
 *
 * Exported for tests.
 */
export async function capOutputForInline(
  output: string,
  toolCallId: string,
  sessionDir: string | undefined,
  maxInlineBytes: number
): Promise<CappedOutput> {
  const totalBytes = Buffer.byteLength(output, 'utf8');
  if (totalBytes <= maxInlineBytes) {
    return { inline: output, savedPath: null, totalBytes };
  }

  const lineCount = countLines(output);
  let savedPath: string | null = null;

  if (sessionDir) {
    try {
      const dir = join(sessionDir, BASH_OUTPUT_SUBDIR);
      await mkdir(dir, { recursive: true });
      const candidate = join(dir, safeOutputFilename(toolCallId));
      await writeFile(candidate, output, 'utf-8');
      savedPath = candidate;
    } catch (err) {
      log.warn('[bash] Failed to save large output to file; falling back to truncate-only:', err);
      savedPath = null;
    }
  }

  const HEADER_OVERHEAD_BYTES = 512;
  const previewBudgetBytes = Math.max(0, maxInlineBytes - HEADER_OVERHEAD_BYTES);

  let head = '';
  let tail = '';
  if (previewBudgetBytes > 0) {
    // 80/20 split between head and tail.
    const headBudgetBytes = Math.min(PREVIEW_HEAD_BYTES, Math.floor(previewBudgetBytes * 0.8));
    const tailBudgetBytes = Math.min(PREVIEW_TAIL_BYTES, previewBudgetBytes - headBudgetBytes);
    head = takeFirstNBytes(output, headBudgetBytes);
    tail = tailBudgetBytes > 0 ? takeLastNBytes(output, tailBudgetBytes) : '';
  }

  const headerLine = savedPath
    ? `[Output saved to ${savedPath} — ${totalBytes.toLocaleString()} bytes, ${lineCount.toLocaleString()} lines]`
    : `[Output too large to inline — ${totalBytes.toLocaleString()} bytes, ${lineCount.toLocaleString()} lines; file save unavailable]`;

  /** Render the inline payload from the current head/tail. Pure: depends only
   *  on the outer-scope `headerLine`, `savedPath`, `totalBytes`. The final
   *  guard loop below repeatedly calls this with shrunken previews and
   *  re-measures until the result fits `maxInlineBytes`. */
  const renderInline = (h: string, t: string): string => {
    const hBytes = Buffer.byteLength(h, 'utf8');
    const tBytes = Buffer.byteLength(t, 'utf8');
    const truncated = Math.max(0, totalBytes - hBytes - tBytes);
    const guidance = savedPath
      ? `[Showing first ${hBytes.toLocaleString()} bytes + last ${tBytes.toLocaleString()} bytes. Use the read tool with offset/limit on the file above, or run bash again with grep/tail/sed/awk on the file path to inspect specific portions.]`
      : `[Showing first ${hBytes.toLocaleString()} bytes + last ${tBytes.toLocaleString()} bytes.]`;
    // Header-only when there's no preview content to show; skip the truncation
    // marker too (nothing on either side of it).
    if (h.length === 0 && t.length === 0) {
      return `${headerLine}\n${guidance}`;
    }
    return `${headerLine}\n${guidance}\n\n${h}\n\n[...${truncated.toLocaleString()} bytes truncated...]\n\n${t}`;
  };

  let inline = renderInline(head, tail);

  // Final-guard loop: enforce `maxInlineBytes` on the actual rendered byte
  // length. Reasons it can exceed the initial estimate:
  //   - Long `savedPath` (e.g. nested test/tmp directories) consumes more
  //     than HEADER_OVERHEAD_BYTES of the header.
  //   - Locale-formatted count fields wider than expected.
  //   - Multi-byte characters at the head/tail boundaries that
  //     `takeFirstNBytes` / `takeLastNBytes` couldn't shrink further than
  //     their budgets.
  // Strategy: halve `head` until fit; if still over with `head` empty, halve
  // `tail`; final fallback is `head = tail = ''` (header-only).
  while (Buffer.byteLength(inline, 'utf8') > maxInlineBytes && head.length > 0) {
    const newBudget = Math.max(0, Math.floor(Buffer.byteLength(head, 'utf8') / 2));
    head = takeFirstNBytes(head, newBudget);
    inline = renderInline(head, tail);
  }
  while (Buffer.byteLength(inline, 'utf8') > maxInlineBytes && tail.length > 0) {
    const newBudget = Math.max(0, Math.floor(Buffer.byteLength(tail, 'utf8') / 2));
    tail = takeLastNBytes(tail, newBudget);
    inline = renderInline(head, tail);
  }
  // If even the header-only render exceeds `maxInlineBytes` (only possible
  // when `savedPath` itself is longer than the cap — pathological), return
  // it anyway: a 1-byte overshoot on a vital pointer is better than dropping
  // the pointer entirely. This is unreachable under the CLI validator's
  // 4 KB minimum unless someone calls the function directly with a tiny cap.

  return { inline, savedPath, totalBytes };
}

/** Replace `details.stdout` / `details.stderr` with a short marker pointing at
 *  the saved file when output was persisted. The persisted message in the
 *  JSONL stores `details`, so without this the full output would be re-stored
 *  there even though `content` (what the model sees) is capped. The saved
 *  file is the source of truth for the operator. */
function shrinkDetailsForSavedOutput(savedPath: string, totalBytes: number): string {
  return `[Saved to ${savedPath} — ${totalBytes.toLocaleString()} bytes; see file for full content]`;
}

export function createBashTool(notifyBackground?: NotifyBackground, opts: BashToolOptions = {}) {
  const sessionDir = opts.sessionDir;
  const maxInlineOutputBytes = opts.maxInlineOutputBytes ?? DEFAULT_BASH_MAX_INLINE_OUTPUT_BYTES;
  // Track background processes for cleanup
  const backgroundProcesses = new Map<string, ChildProcess>();

  const bashParams = Type.Object({
    command: Type.String({
      description: 'The shell command to execute',
    }),
    cwd: Type.Optional(
      Type.String({
        description: 'Working directory for the command (defaults to user home)',
      })
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          'If true, start the command in the background and return immediately. You will receive the output as a follow-up message when the command completes. Use for long-running commands (builds, large data processing, etc.).',
      })
    ),
    inactivity_timeout_seconds: Type.Optional(
      Type.Number({
        description:
          'Inactivity timeout in seconds (10-600, default 60). The timer resets on every stdout/stderr output. Scripts can emit "::system2:: <message>" lines to reset the timer and push progress to the UI. Only takes effect when explicitly provided (legacy 120s fixed timeout otherwise).',
        minimum: 10,
        maximum: 600,
      })
    ),
    total_timeout_seconds: Type.Optional(
      Type.Number({
        description:
          'Total (wall-clock) timeout in seconds (10-600, default 600). Hard cap that never resets. Only takes effect when explicitly provided (legacy 120s fixed timeout otherwise).',
        minimum: 10,
        maximum: 600,
      })
    ),
  });

  const tool: AgentTool<typeof bashParams> = {
    name: 'bash',
    label: 'Execute Shell Command',
    description:
      'Execute a shell command and return stdout/stderr. 120-second timeout by default. Uses PowerShell on Windows, bash on macOS/Linux. Set run_in_background to true for long-running commands — you will be notified when they complete. Output is streamed as the command runs. For long-running foreground commands, set inactivity_timeout_seconds and/or total_timeout_seconds to use dual timeouts (inactivity resets on output, total is a hard cap). Scripts can emit "::system2:: <message>" on stdout as heartbeats to reset the inactivity timer and show progress in the UI. Large output (>128 KB UTF-8 bytes by default) is saved to a file under the agent\'s session directory; the response shows head + tail previews plus the file path. To inspect specific portions of the saved file: use the `read` tool with `offset` (1-indexed line) and `limit` (line count) — works on any OS — or rerun `bash` with filtering commands against the file path: `grep`/`tail`/`sed`/`awk` on macOS/Linux, `Select-String`/`Get-Content -Tail N`/`Get-Content -TotalCount N` on Windows (PowerShell). `read` truncates at 2,000 lines or 50 KB per call and tells you the next `offset` to continue from.',
    parameters: bashParams,
    execute: async (_toolCallId, rawParams, signal, onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof bashParams>;
      // Block catastrophic commands before execution
      for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
        if (pattern.test(params.command)) {
          return {
            content: [
              {
                type: 'text',
                text: `Command blocked: ${reason}. Rephrase the command or use a safer alternative.`,
              },
            ],
            details: { stdout: '', stderr: reason, exitCode: 1 },
          };
        }
      }

      const cwd = params.cwd || homedir();

      // Background execution
      if (params.run_in_background && notifyBackground) {
        // Spawn without timeout for background commands
        const args = isWindows ? ['-Command', params.command] : ['-c', params.command];
        const child = spawn(shellCmd, args, { cwd, env: process.env });

        const id = _toolCallId;
        backgroundProcesses.set(id, child);

        let stdout = '';
        let stderr = '';
        // Running UTF-8 byte counts so MAX_BUFFER enforces on bytes (its
        // documented unit). See the runCommand version for rationale.
        let stdoutBytes = 0;
        let stderrBytes = 0;

        let bgPendingLine = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          const text = bgPendingLine + chunk.toString();
          bgPendingLine = '';
          const lastNewline = text.lastIndexOf('\n');
          if (lastNewline === -1) {
            bgPendingLine = text;
            return;
          }
          const complete = text.slice(0, lastNewline + 1);
          bgPendingLine = text.slice(lastNewline + 1);
          const { filtered } = filterHeartbeats(complete);
          if (filtered) {
            const filteredBytes = Buffer.byteLength(filtered, 'utf8');
            if (stdoutBytes + filteredBytes <= MAX_BUFFER) {
              stdout += filtered;
              stdoutBytes += filteredBytes;
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          const textBytes = Buffer.byteLength(text, 'utf8');
          if (stderrBytes + textBytes <= MAX_BUFFER) {
            stderr += text;
            stderrBytes += textBytes;
          }
        });

        // Kill background process on abort
        const onAbort = () => {
          child.kill('SIGTERM');
          backgroundProcesses.delete(id);
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code) => {
          // Flush remaining partial line
          if (bgPendingLine) {
            const { filtered } = filterHeartbeats(bgPendingLine);
            if (filtered) {
              const filteredBytes = Buffer.byteLength(filtered, 'utf8');
              if (stdoutBytes + filteredBytes <= MAX_BUFFER) {
                stdout += filtered;
                stdoutBytes += filteredBytes;
              }
            }
            bgPendingLine = '';
          }
          backgroundProcesses.delete(id);
          signal?.removeEventListener('abort', onAbort);
          const exitCode = code ?? 0;
          const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
          // Wrap async work in an IIFE so the 'close' callback stays sync;
          // any rejection is logged but does not unwind a non-async caller.
          void (async () => {
            try {
              const capped = await capOutputForInline(output, id, sessionDir, maxInlineOutputBytes);
              const prefix =
                exitCode === 0 ? 'Background command completed' : 'Background command failed';
              // When output was saved to file, both stdout and stderr details
              // point at the saved file — the file contains the combined
              // stdout + STDERR-prefixed stderr, so the marker fully
              // substitutes for the per-channel content. Operators inspect
              // the file rather than the JSONL fields.
              const marker = capped.savedPath
                ? shrinkDetailsForSavedOutput(capped.savedPath, capped.totalBytes)
                : null;
              notifyBackground(
                `${prefix}: ${params.command}\n\n${capped.inline || '(no output)'}`,
                {
                  stdout: marker ?? stdout,
                  stderr: marker ?? stderr,
                  exitCode,
                  command: params.command,
                }
              );
            } catch (err) {
              log.error('[bash] Failed to deliver background output:', err);
              // Reflect the actual exit code in the prefix so operators
              // don't see "completed" for a command that actually failed.
              const fallbackPrefix =
                exitCode === 0 ? 'Background command completed' : 'Background command failed';
              notifyBackground(
                `${fallbackPrefix} (delivery error): ${params.command}\n\n(internal error capping output)`,
                {
                  stdout: '',
                  stderr: '',
                  exitCode,
                  command: params.command,
                }
              );
            }
          })();
        });

        child.on('error', (err) => {
          backgroundProcesses.delete(id);
          signal?.removeEventListener('abort', onAbort);
          notifyBackground(`Background command error: ${params.command}\n\n${err.message}`, {
            stdout,
            stderr,
            exitCode: 1,
            error: err.message,
            command: params.command,
          });
        });

        return {
          content: [{ type: 'text', text: `Command started in background: ${params.command}` }],
          details: {
            stdout: '',
            stderr: '',
            exitCode: -1,
            background: true,
            command: params.command,
          },
        };
      }

      // Compute effective timeouts
      const hasTimeoutParams =
        params.inactivity_timeout_seconds !== undefined ||
        params.total_timeout_seconds !== undefined;

      let inactivityMs: number;
      let totalMs: number;

      if (hasTimeoutParams) {
        // New dual-timeout model
        inactivityMs = params.inactivity_timeout_seconds
          ? clamp(params.inactivity_timeout_seconds * 1000, MIN_TIMEOUT, MAX_TIMEOUT)
          : DEFAULT_INACTIVITY_TIMEOUT;
        totalMs = params.total_timeout_seconds
          ? clamp(params.total_timeout_seconds * 1000, MIN_TIMEOUT, MAX_TIMEOUT)
          : DEFAULT_TOTAL_TIMEOUT;
      } else {
        // Legacy: single fixed timeout matching the old 120s behavior
        inactivityMs = LEGACY_TIMEOUT;
        totalMs = LEGACY_TIMEOUT;
      }

      // Foreground execution with streaming
      try {
        const { stdout, stderr, exitCode } = await runCommand(
          params.command,
          cwd,
          inactivityMs,
          totalMs,
          signal,
          onUpdate
        );

        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
        const capped = await capOutputForInline(
          output,
          _toolCallId,
          sessionDir,
          maxInlineOutputBytes
        );
        // Both channels point at the saved file when output was persisted:
        // the file holds the combined stdout + STDERR-prefixed stderr, so
        // the marker covers both per-channel slots in the JSONL details.
        const marker = capped.savedPath
          ? shrinkDetailsForSavedOutput(capped.savedPath, capped.totalBytes)
          : null;
        const detailsStdout = marker ?? stdout;
        const detailsStderr = marker ?? stderr;

        if (exitCode !== 0) {
          // Build the failure response from the capped representation so the
          // inline payload stays bounded even on long error dumps.
          return {
            content: [
              {
                type: 'text',
                text: `Command failed (exit code ${exitCode}):\n\n${capped.inline}`,
              },
            ],
            details: { stdout: detailsStdout, stderr: detailsStderr, exitCode },
          };
        }

        return {
          content: [{ type: 'text', text: capped.inline || '(command completed with no output)' }],
          details: { stdout: detailsStdout, stderr: detailsStderr, exitCode },
        };
      } catch (error: unknown) {
        const err = error as {
          message?: string;
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        };
        const errorMsg = err.message || String(error);
        const stdout = err.stdout || '';
        const stderr = err.stderr || '';
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
        const capped = await capOutputForInline(
          output,
          _toolCallId,
          sessionDir,
          maxInlineOutputBytes
        );
        const marker = capped.savedPath
          ? shrinkDetailsForSavedOutput(capped.savedPath, capped.totalBytes)
          : null;
        const detailsStdout = marker ?? stdout;
        const detailsStderr = marker ?? stderr;

        return {
          content: [
            {
              type: 'text',
              text: `Command failed:\n${errorMsg}\n\n${capped.inline}`,
            },
          ],
          details: {
            error: errorMsg,
            stdout: detailsStdout,
            stderr: detailsStderr,
            exitCode: err.exitCode || 1,
          },
        };
      }
    },
  };
  return tool;
}
