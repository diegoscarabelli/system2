/**
 * Read Tool
 *
 * Reads file contents from the filesystem.
 */

import { readFile } from 'node:fs/promises';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import { resolvePath } from './resolve-path.js';

export function createReadTool() {
  const readParams = Type.Object({
    path: Type.String({
      description: 'Path to the file to read (absolute or relative to home directory)',
    }),
  });

  const tool: AgentTool<typeof readParams> = {
    name: 'read',
    label: 'Read File',
    description:
      'Read the contents of a file from the filesystem. Accepts absolute paths or ~/ relative paths. Returns the full file content as text. Use this to inspect files before editing, review data outputs, or read configuration.',
    parameters: readParams,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof readParams>;
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
