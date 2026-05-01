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
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';

const LEGACY_TIMEOUT = 120_000; // 120s fixed timeout (backward compat when no timeout params given)
const DEFAULT_INACTIVITY_TIMEOUT = 60_000; // 60 seconds
const DEFAULT_TOTAL_TIMEOUT = 600_000; // 10 minutes
const MIN_TIMEOUT = 10_000; // 10 seconds
const MAX_TIMEOUT = 600_000; // 10 minutes
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

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

export function createBashTool(notifyBackground?: NotifyBackground) {
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
      'Execute a shell command and return stdout/stderr. 120-second timeout by default. Uses PowerShell on Windows, bash on macOS/Linux. Set run_in_background to true for long-running commands — you will be notified when they complete. Output is streamed as the command runs. For long-running foreground commands, set inactivity_timeout_seconds and/or total_timeout_seconds to use dual timeouts (inactivity resets on output, total is a hard cap). Scripts can emit "::system2:: <message>" on stdout as heartbeats to reset the inactivity timer and show progress in the UI.',
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
          const prefix =
            exitCode === 0 ? 'Background command completed' : 'Background command failed';
          notifyBackground(`${prefix}: ${params.command}\n\n${output || '(no output)'}`, {
            stdout,
            stderr,
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

        if (exitCode !== 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Command failed (exit code ${exitCode}):\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
              },
            ],
            details: { stdout, stderr, exitCode },
          };
        }

        return {
          content: [{ type: 'text', text: output || '(command completed with no output)' }],
          details: { stdout, stderr, exitCode },
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

        return {
          content: [
            {
              type: 'text',
              text: `Command failed:\n${errorMsg}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
            },
          ],
          details: {
            error: errorMsg,
            stdout,
            stderr,
            exitCode: err.exitCode || 1,
          },
        };
      }
    },
  };
  return tool;
}
