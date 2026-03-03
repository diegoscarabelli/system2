/**
 * Bash Tool
 *
 * Executes shell commands with timeout and workspace constraints.
 */

import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const execAsync = promisify(exec);

export function createBashTool(): AgentTool<any> {
  const params = Type.Object({
    command: Type.String({
      description: 'The shell command to execute (bash syntax)',
    }),
    cwd: Type.Optional(
      Type.String({
        description: 'Working directory for the command (defaults to user home)',
      })
    ),
  });

  return {
    name: 'bash',
    label: 'Execute Bash Command',
    description:
      'Execute a shell command and return stdout/stderr. Use for system detection, checking installed tools, running package managers, etc.',
    parameters: params,
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      try {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd: params.cwd || homedir(),
          timeout: 30000, // 30 second timeout
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          signal,
        });

        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');

        return {
          content: [{ type: 'text', text: output || '(command completed with no output)' }],
          details: { stdout, stderr, exitCode: 0 },
        };
      } catch (error: any) {
        const errorMsg = error.message || String(error);
        const stdout = error.stdout || '';
        const stderr = error.stderr || '';

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
            exitCode: error.code || 1,
          },
        };
      }
    },
  };
}
