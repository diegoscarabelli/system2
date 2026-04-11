/**
 * Shell Tool
 *
 * Executes shell commands with streaming output, background execution,
 * and proper AbortSignal handling. Uses PowerShell on Windows, default
 * shell (bash) on macOS/Linux.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const DEFAULT_TIMEOUT = 120_000; // 120 seconds
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

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
    pattern: /\brm\b[^;|&]*(--recursive|-[a-zA-Z]*[rR])[^;|&]*\s+\$HOME\/?(\s|$|\*)/,
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
    pattern: /\bdd\b[^;|&]*\bof=\/dev\//,
    reason: 'Writing to raw block devices (dd of=/dev/) is blocked',
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
}

/**
 * Run a command via spawn, collect output, stream via onUpdate, respect AbortSignal.
 */
function runCommand(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<BashDetails>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const args = isWindows ? ['-Command', command] : ['-c', command];
    const child = spawn(shellCmd, args, { cwd, env: process.env });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timerHandle: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (settled) return;
      settled = true;
      if (timerHandle) clearTimeout(timerHandle);
      cleanup();
      resolve(result);
    };

    const fail = (error: Error & { stdout?: string; stderr?: string; exitCode?: number }) => {
      if (settled) return;
      settled = true;
      if (timerHandle) clearTimeout(timerHandle);
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

    // Timeout
    timerHandle = setTimeout(() => {
      child.kill('SIGTERM');
      const err = new Error(`Command timed out after ${timeout / 1000}s`) as Error & {
        exitCode?: number;
      };
      err.exitCode = 124;
      fail(err);
    }, timeout);

    // Collect and stream output
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdout.length + text.length <= MAX_BUFFER) {
        stdout += text;
      }
      onUpdate?.({
        content: [{ type: 'text', text: stdout + (stderr ? `\nSTDERR:\n${stderr}` : '') }],
        details: { stdout, stderr, exitCode: -1 },
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length + text.length <= MAX_BUFFER) {
        stderr += text;
      }
      onUpdate?.({
        content: [{ type: 'text', text: stdout + (stderr ? `\nSTDERR:\n${stderr}` : '') }],
        details: { stdout, stderr, exitCode: -1 },
      });
    });

    child.on('close', (code) => {
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

  const params = Type.Object({
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
  });

  const tool: AgentTool<typeof params> = {
    name: 'bash',
    label: 'Execute Shell Command',
    description:
      'Execute a shell command and return stdout/stderr. 120-second timeout by default. Uses PowerShell on Windows, bash on macOS/Linux. Set run_in_background to true for long-running commands — you will be notified when they complete. Output is streamed as the command runs.',
    parameters: params,
    execute: async (_toolCallId, params, signal, onUpdate) => {
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

        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          if (stdout.length + text.length <= MAX_BUFFER) stdout += text;
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

      // Foreground execution with streaming
      try {
        const { stdout, stderr, exitCode } = await runCommand(
          params.command,
          cwd,
          DEFAULT_TIMEOUT,
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
