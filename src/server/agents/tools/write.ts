/**
 * Write Tool
 *
 * Writes content to files on the filesystem.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { commitIfStateDir } from './git-commit.js';
import { resolvePath } from './resolve-path.js';

/** Max bytes of existing content to include in the overwrite warning. */
const PREVIEW_BYTES = 200;

export function createWriteTool() {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to write (absolute or relative to home directory)',
    }),
    content: Type.String({
      description: 'Content to write to the file',
    }),
    commit_message: Type.Optional(
      Type.String({
        description:
          'If provided and path is inside ~/.system2/, git-commit the file with this message after writing',
      })
    ),
  });

  const tool: AgentTool<typeof params> = {
    name: 'write',
    label: 'Write File',
    description:
      'Write content to a file. Creates parent directories if needed. WARNING: this tool REPLACES the entire file content. Any existing content not included in `content` will be permanently lost. Use this ONLY for creating new files or complete rewrites where you provide ALL content. To add a section to an existing file (e.g. adding a [databases.*] entry to config.toml), use the `edit` tool with `append: true` so you do not destroy existing sections. For modifying specific parts, use `edit`. For bulk replacements, use `bash` with `sed` or `awk`.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        const filePath = resolvePath(params.path);

        // Check if we're about to overwrite an existing file
        let overwriteWarning = '';
        try {
          const stats = await stat(filePath);
          if (stats.isFile() && stats.size > 0) {
            const existing = await readFile(filePath, 'utf-8');
            const preview =
              existing.length > PREVIEW_BYTES ? `${existing.slice(0, PREVIEW_BYTES)}...` : existing;
            overwriteWarning =
              `\n\nWARNING: Overwrote existing file (${stats.size} bytes). ` +
              `Previous content started with:\n${preview}\n\n` +
              'If this was unintentional, the existing content is now lost. ' +
              'Use the `edit` tool to modify files without replacing them entirely.';
          }
        } catch {
          // File doesn't exist, no warning needed
        }

        const dir = dirname(filePath);
        await mkdir(dir, { recursive: true });

        await writeFile(filePath, params.content, 'utf-8');

        if (params.commit_message) {
          commitIfStateDir(filePath, params.commit_message);
        }

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${params.content.length} bytes to ${params.path}${overwriteWarning}`,
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
