/**
 * Edit Tool
 *
 * Performs exact string replacement in files. Finds `old_string` in the file,
 * verifies it appears exactly once (uniqueness check), and replaces it with
 * `new_string`. For insertions, use surrounding context as `old_string` and
 * embed the new content in `new_string`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { commitIfStateDir } from './git-commit.js';

export function createEditTool() {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to edit (absolute or relative to home directory)',
    }),
    old_string: Type.String({
      description:
        'The exact text to find in the file. Must appear exactly once. Include enough surrounding context to make it unique.',
    }),
    new_string: Type.String({
      description:
        'The replacement text. For insertions, include the original context with new content added in the right position.',
    }),
    commit_message: Type.Optional(
      Type.String({
        description:
          'If provided and path is inside ~/.system2/, git-commit the file with this message after editing',
      })
    ),
  });

  const tool: AgentTool<typeof params> = {
    name: 'edit',
    label: 'Edit File',
    description:
      'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file (include more context if not unique). Prefer this over `write` for modifying existing files — it only changes what you specify. Use `write` for creating new files or complete rewrites. For bulk operations where `edit` is inconvenient (e.g., find-and-replace across many lines, appending), use `bash` with `sed`, `awk`, `>>`, or similar.',
    parameters: params,
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      try {
        if (signal?.aborted) {
          return {
            content: [{ type: 'text', text: 'Edit aborted.' }],
            details: { error: 'aborted' },
          };
        }

        const filePath = isAbsolute(params.path) ? params.path : resolve(homedir(), params.path);

        const content = await readFile(filePath, 'utf-8');

        if (params.old_string === params.new_string) {
          return {
            content: [{ type: 'text', text: 'Error: old_string and new_string are identical.' }],
            details: { error: 'identical_strings' },
          };
        }

        // Count occurrences
        let count = 0;
        let searchFrom = 0;
        while (true) {
          const idx = content.indexOf(params.old_string, searchFrom);
          if (idx === -1) break;
          count++;
          searchFrom = idx + 1;
        }

        if (count === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: old_string not found in ${params.path}. Make sure it matches the file content exactly, including whitespace and indentation.`,
              },
            ],
            details: { error: 'not_found', path: filePath },
          };
        }

        if (count > 1) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: old_string appears ${count} times in ${params.path}. Include more surrounding context in old_string to make it unique.`,
              },
            ],
            details: { error: 'not_unique', count, path: filePath },
          };
        }

        if (signal?.aborted) {
          return {
            content: [{ type: 'text', text: 'Edit aborted.' }],
            details: { error: 'aborted' },
          };
        }

        // Perform the replacement
        const matchIndex = content.indexOf(params.old_string);
        const newContent =
          content.slice(0, matchIndex) +
          params.new_string +
          content.slice(matchIndex + params.old_string.length);

        await writeFile(filePath, newContent, 'utf-8');

        if (params.commit_message) {
          commitIfStateDir(filePath, params.commit_message);
        }

        // Calculate line range of the change
        const linesBefore = content.slice(0, matchIndex).split('\n').length;
        const linesChanged = params.new_string.split('\n').length;

        return {
          content: [
            {
              type: 'text',
              text: `Edited ${params.path} — replaced ${params.old_string.split('\n').length} line(s) at line ${linesBefore} with ${linesChanged} line(s).`,
            },
          ],
          details: { path: filePath, startLine: linesBefore, linesChanged },
        };
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        const errorMsg =
          err.code === 'ENOENT' ? `File not found: ${params.path}` : err.message || String(error);

        return {
          content: [{ type: 'text', text: `Error editing file: ${errorMsg}` }],
          details: { error: errorMsg, path: params.path },
        };
      }
    },
  };
  return tool;
}
