/**
 * Write Tool
 *
 * Writes content to files on the filesystem.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

export function createWriteTool(): AgentTool<any> {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to write (absolute or relative to home directory)',
    }),
    content: Type.String({
      description: 'Content to write to the file',
    }),
  });

  return {
    name: 'write',
    label: 'Write File',
    description:
      'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        // Resolve path relative to home if not absolute
        const filePath = params.path.startsWith('/')
          ? params.path
          : resolve(process.env.HOME || '~', params.path);

        // Ensure parent directory exists
        const dir = dirname(filePath);
        await mkdir(dir, { recursive: true });

        // Write file
        await writeFile(filePath, params.content, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
            },
          ],
          details: { path: filePath, size: params.content.length },
        };
      } catch (error: any) {
        const errorMsg = error.message || String(error);

        return {
          content: [{ type: 'text', text: `Error writing file: ${errorMsg}` }],
          details: { error: errorMsg, path: params.path },
        };
      }
    },
  };
}
