/**
 * Write Tool
 *
 * Writes content to files on the filesystem.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

export function createWriteTool() {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to write (absolute or relative to home directory)',
    }),
    content: Type.String({
      description: 'Content to write to the file',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'write',
    label: 'Write File',
    description:
      'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        const filePath = isAbsolute(params.path) ? params.path : resolve(homedir(), params.path);

        const dir = dirname(filePath);
        await mkdir(dir, { recursive: true });

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
      } catch (error: unknown) {
        const errorMsg = (error as Error).message || String(error);

        return {
          content: [{ type: 'text', text: `Error writing file: ${errorMsg}` }],
          details: { error: errorMsg, path: params.path },
        };
      }
    },
  };
  return tool;
}
