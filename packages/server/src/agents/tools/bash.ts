/**
 * Shell Tool
 *
 * Executes shell commands with timeout and workspace constraints.
 * Uses PowerShell on Windows, default shell (bash) on macOS/Linux.
 */

import { exec } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const execAsync = promisify(exec);

// On Windows, use PowerShell instead of cmd.exe for better scripting support
const isWindows = platform() === 'win32';
const shellOption = isWindows ? { shell: 'powershell.exe' } : {};

export function createBashTool() {
  const params = Type.Object({
    command: Type.String({
      description: 'The shell command to execute',
    }),
    cwd: Type.Optional(
      Type.String({
        description: 'Working directory for the command (defaults to user home)',
      })
    ),
  });

  const tool: AgentTool<typeof params> = {
    name: 'bash',
    label: 'Execute Shell Command',
    description:
      'Execute a shell command and return stdout/stderr. Uses PowerShell on Windows, bash on macOS/Linux. Use for system detection, checking installed tools, running package managers, etc.',
    parameters: params,
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      try {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd: params.cwd || homedir(),
          timeout: 30000, // 30 second timeout
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          signal,
          ...shellOption,
        });

        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');

        return {
          content: [{ type: 'text', text: output || '(command completed with no output)' }],
          details: { stdout, stderr, exitCode: 0 },
        };
      } catch (error: unknown) {
        const err = error as { message?: string; stdout?: string; stderr?: string; code?: number };
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
            exitCode: err.code || 1,
          },
        };
      }
    },
  };
  return tool;
}
