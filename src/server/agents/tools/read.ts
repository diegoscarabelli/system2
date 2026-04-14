/**
 * Read Tool
 *
 * Reads file contents from the filesystem.
 */

import { readFile } from 'node:fs/promises';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { resolvePath } from './resolve-path.js';

export function createReadTool() {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to read (absolute or relative to home directory)',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'read',
    label: 'Read File',
    description:
      'Read the contents of a file from the filesystem. Accepts absolute paths or ~/ relative paths. Returns the full file content as text. Use this to inspect files before editing, review data outputs, or read configuration.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        const filePath = resolvePath(params.path);

        const content = await readFile(filePath, 'utf-8');

        return {
          content: [{ type: 'text', text: content }],
          details: { path: filePath, size: content.length },
        };
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        const errorMsg =
          err.code === 'ENOENT' ? `File not found: ${params.path}` : err.message || String(error);

        return {
          content: [{ type: 'text', text: `Error reading file: ${errorMsg}` }],
          details: { error: errorMsg, path: params.path },
        };
      }
    },
  };
  return tool;
}
