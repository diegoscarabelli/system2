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
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
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

      if (filtered && stdout.length + filtered.length <= MAX_BUFFER) {
        stdout += filtered;
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
      if (stderr.length + text.length <= MAX_BUFFER) {
        stderr += text;
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
        if (filtered && stdout.length + filtered.length <= MAX_BUFFER) {
          stdout += filtered;
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

/** Cheap newline scan; avoids `split('\n')` allocating an N-element array on
 *  near-MAX_BUFFER outputs. Treats trailing newline as terminating the last
 *  line (i.e., "a\nb\n".lineCount === 2), matching `split('\n').length - 1`
 *  for non-empty inputs and 1 for the empty string. */
function countLines(s: string): number {
  if (s.length === 0) return 1;
  let n = 1;
  let i = -1;
  // biome-ignore lint/suspicious/noAssignInExpressions: tight loop, standard scan pattern
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

/**
 * Cap inline tool output. If the output's UTF-8 byte size exceeds
 * `maxInlineBytes` and `sessionDir` is available, write the full output to
 * `<sessionDir>/bash-output/<toolCallId>.log` and return a string containing
 * a header pointer + head/tail previews + a "[...N bytes truncated...]"
 * marker between them. If `sessionDir` is absent or the file write fails,
 * truncate without saving (best-effort).
 *
 * Byte accounting uses `Buffer.byteLength(..., 'utf8')` rather than
 * `string.length` (which counts UTF-16 code units): for non-ASCII output the
 * two diverge, and the cap is documented as a byte cap. Preview slicing
 * stays in code-unit space because slicing the UTF-8 byte stream on a
 * non-boundary would corrupt multi-byte characters; the slice budgets are
 * conservative (the saved file is the source of truth).
 *
 * Preview budgets are clamped so that head + tail + header overhead never
 * exceed `maxInlineBytes`. For tiny `maxInlineBytes` (e.g. tests using 1 KB)
 * head and tail are scaled down rather than allowed to overlap.
 *
 * Exported for tests.
 */
export function capOutputForInline(
  output: string,
  toolCallId: string,
  sessionDir: string | undefined,
  maxInlineBytes: number
): CappedOutput {
  const totalBytes = Buffer.byteLength(output, 'utf8');
  if (totalBytes <= maxInlineBytes) {
    return { inline: output, savedPath: null, totalBytes };
  }

  const lineCount = countLines(output);
  let savedPath: string | null = null;

  if (sessionDir) {
    try {
      const dir = join(sessionDir, BASH_OUTPUT_SUBDIR);
      mkdirSync(dir, { recursive: true });
      savedPath = join(dir, `${toolCallId}.log`);
      writeFileSync(savedPath, output, 'utf-8');
    } catch (err) {
      log.warn('[bash] Failed to save large output to file; falling back to truncate-only:', err);
      savedPath = null;
    }
  }

  // Reserve a small slice of `maxInlineBytes` for the header + guidance +
  // truncation marker so head + tail never push the inline payload over
  // `maxInlineBytes`. Numbers are rough — the exact overhead depends on
  // toLocaleString output for the byte counts, but ~512 is a safe upper bound.
  const HEADER_OVERHEAD_BYTES = 512;
  const previewBudgetBytes = Math.max(0, maxInlineBytes - HEADER_OVERHEAD_BYTES);
  // 80/20 split between head and tail; the head is more useful for diagnostics
  // (initial error message, command echo, etc.).
  const headBudgetBytes = Math.min(PREVIEW_HEAD_BYTES, Math.floor(previewBudgetBytes * 0.8));
  const tailBudgetBytes = Math.min(PREVIEW_TAIL_BYTES, previewBudgetBytes - headBudgetBytes);

  // Slice in code-unit space — see function docstring for why.
  const head = output.slice(0, headBudgetBytes);
  const tail = tailBudgetBytes > 0 ? output.slice(-tailBudgetBytes) : '';
  const headBytes = Buffer.byteLength(head, 'utf8');
  const tailBytes = Buffer.byteLength(tail, 'utf8');
  const truncatedBytes = Math.max(0, totalBytes - headBytes - tailBytes);

  const headerLine = savedPath
    ? `[Output saved to ${savedPath} — ${totalBytes.toLocaleString()} bytes, ${lineCount.toLocaleString()} lines]`
    : `[Output too large to inline — ${totalBytes.toLocaleString()} bytes, ${lineCount.toLocaleString()} lines; file save unavailable]`;
  const guidanceLine = savedPath
    ? `[Showing first ${headBytes.toLocaleString()} bytes + last ${tailBytes.toLocaleString()} bytes. Use the read tool with offset/limit on the file above, or run bash again with grep/tail/sed/awk on the file path to inspect specific portions.]`
    : `[Showing first ${headBytes.toLocaleString()} bytes + last ${tailBytes.toLocaleString()} bytes.]`;

  const inline = `${headerLine}\n${guidanceLine}\n\n${head}\n\n[...${truncatedBytes.toLocaleString()} bytes truncated...]\n\n${tail}`;
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
      'Execute a shell command and return stdout/stderr. 120-second timeout by default. Uses PowerShell on Windows, bash on macOS/Linux. Set run_in_background to true for long-running commands — you will be notified when they complete. Output is streamed as the command runs. For long-running foreground commands, set inactivity_timeout_seconds and/or total_timeout_seconds to use dual timeouts (inactivity resets on output, total is a hard cap). Scripts can emit "::system2:: <message>" on stdout as heartbeats to reset the inactivity timer and show progress in the UI. Large output (>128 KB by default) is saved to a file under the agent\'s session directory and the response shows head + tail previews plus the file path so you can read specific slices via the `read` tool (with offset/limit) or rerun bash with grep/tail/sed against the saved file.',
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
          if (filtered && stdout.length + filtered.length <= MAX_BUFFER) stdout += filtered;
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          if (stderr.length + text.length <= MAX_BUFFER) stderr += text;
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
            if (filtered && stdout.length + filtered.length <= MAX_BUFFER) stdout += filtered;
            bgPendingLine = '';
          }
          backgroundProcesses.delete(id);
          signal?.removeEventListener('abort', onAbort);
          const exitCode = code ?? 0;
          const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
          const capped = capOutputForInline(output, id, sessionDir, maxInlineOutputBytes);
          const prefix =
            exitCode === 0 ? 'Background command completed' : 'Background command failed';
          // When output was saved to file, shrink the persisted details so the
          // JSONL message doesn't re-store the same megabytes that already live
          // in the saved file. The marker tells operators where to look.
          const detailsStdout = capped.savedPath
            ? shrinkDetailsForSavedOutput(capped.savedPath, capped.totalBytes)
            : stdout;
          const detailsStderr = capped.savedPath ? '' : stderr;
          notifyBackground(`${prefix}: ${params.command}\n\n${capped.inline || '(no output)'}`, {
            stdout: detailsStdout,
            stderr: detailsStderr,
            exitCode,
            command: params.command,
          });
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
        const capped = capOutputForInline(output, _toolCallId, sessionDir, maxInlineOutputBytes);
        const detailsStdout = capped.savedPath
          ? shrinkDetailsForSavedOutput(capped.savedPath, capped.totalBytes)
          : stdout;
        const detailsStderr = capped.savedPath ? '' : stderr;

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
        const capped = capOutputForInline(output, _toolCallId, sessionDir, maxInlineOutputBytes);
        const detailsStdout = capped.savedPath
          ? shrinkDetailsForSavedOutput(capped.savedPath, capped.totalBytes)
          : stdout;
        const detailsStderr = capped.savedPath ? '' : stderr;

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
