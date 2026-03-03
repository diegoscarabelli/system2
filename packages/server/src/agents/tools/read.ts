/**
 * Read Tool
 *
 * Reads file contents from the filesystem.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

export function createReadTool(): AgentTool<any> {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to read (absolute or relative to home directory)',
    }),
  });

  return {
    name: 'read',
    label: 'Read File',
    description: 'Read the contents of a file from the filesystem. Supports text files.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        // Resolve path relative to home if not absolute
        const filePath = params.path.startsWith('/')
          ? params.path
          : resolve(process.env.HOME || '~', params.path);

        const content = await readFile(filePath, 'utf-8');

        return {
          content: [{ type: 'text', text: content }],
          details: { path: filePath, size: content.length },
        };
      } catch (error: any) {
        const errorMsg =
          error.code === 'ENOENT'
            ? `File not found: ${params.path}`
            : error.message || String(error);

        return {
          content: [{ type: 'text', text: `Error reading file: ${errorMsg}` }],
          details: { error: errorMsg, path: params.path },
        };
      }
    },
  };
}
