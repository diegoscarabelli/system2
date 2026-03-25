/**
 * Edit Tool
 *
 * Performs exact string replacement in files, or appends content to a file.
 *
 * Replace mode (default): finds `old_string` in the file, verifies it appears
 * exactly once (uniqueness check), and replaces it with `new_string`. For
 * insertions, use surrounding context as `old_string` and embed the new content
 * in `new_string`.
 *
 * Regex mode (`regex: true`): same as replace mode but `old_string` is treated
 * as a JavaScript regex pattern. `new_string` is used as a literal replacement
 * string ($ is not interpreted as a backreference). The pattern must match
 * exactly once.
 *
 * Append mode (`append: true`): appends `new_string` to the end of the file.
 * Creates the file (and parent directories) if it does not exist. Adds a
 * newline separator if the existing content does not end with one.
 */

import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { commitIfStateDir } from './git-commit.js';
import { resolvePath } from './resolve-path.js';

export function createEditTool() {
  const params = Type.Object({
    path: Type.String({
      description: 'Path to the file to edit (absolute or relative to home directory)',
    }),
    old_string: Type.Optional(
      Type.String({
        description:
          'The exact text to find in the file (or a regex pattern when regex is true). Must match exactly once. Include enough surrounding context to make it unique. Required unless append is true.',
      })
    ),
    new_string: Type.String({
      description:
        'The replacement text (replace mode) or content to append (append mode). For insertions in replace mode, include the original context with new content added in the right position.',
    }),
    append: Type.Optional(
      Type.Boolean({
        description:
          'If true, append new_string to the end of the file instead of replacing old_string. Creates the file (and parent directories) if it does not exist.',
      })
    ),
    regex: Type.Optional(
      Type.Boolean({
        description:
          'If true, treat old_string as a JavaScript regular expression pattern. new_string is used as a literal replacement ($ is not interpreted as a backreference). The pattern must match exactly once. Useful for replacing a field value without knowing the current value, e.g. old_string: "last_narrator_update_ts: .*". Ignored when append is true.',
      })
    ),
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
      'Edit a file by replacing an exact string match, or append content to a file. When append is true, appends new_string to the end of the file (creating it if needed) — use this for adding entries to logs, memory files, and similar. When append is not set, old_string must appear exactly once in the file (include more context if not unique). Set regex to true to treat old_string as a regex pattern — useful when you need to replace a field value without knowing the current value (e.g. old_string: "fieldName: .*"). Prefer this over `write` for modifying existing files. Use `write` for creating new files or complete rewrites.',
    parameters: params,
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      try {
        if (signal?.aborted) {
          return {
            content: [{ type: 'text', text: 'Edit aborted.' }],
            details: { error: 'aborted' },
          };
        }

        const filePath = resolvePath(params.path);

        if (params.append) {
          await mkdir(dirname(filePath), { recursive: true });

          // Determine separator by reading only the last byte — avoids loading the
          // entire file and also prevents a double newline when new_string already
          // starts with one (LF or CRLF).
          let separator = '';
          if (!params.new_string.startsWith('\n') && !params.new_string.startsWith('\r')) {
            try {
              const fileStat = await stat(filePath);
              if (fileStat.size > 0) {
                const fh = await open(filePath, 'r');
                try {
                  const buf = Buffer.alloc(1);
                  await fh.read(buf, 0, 1, fileStat.size - 1);
                  if (buf[0] !== 0x0a) separator = '\n';
                } finally {
                  await fh.close();
                }
              }
            } catch (err) {
              const e = err as { code?: string };
              if (e.code !== 'ENOENT') throw err;
            }
          }

          if (signal?.aborted) {
            return {
              content: [{ type: 'text', text: 'Edit aborted.' }],
              details: { error: 'aborted' },
            };
          }

          await appendFile(filePath, separator + params.new_string, 'utf-8');

          if (params.commit_message) {
            commitIfStateDir(filePath, params.commit_message);
          }

          const linesAppended =
            params.new_string === ''
              ? 0
              : params.new_string.split('\n').length - (params.new_string.endsWith('\n') ? 1 : 0);
          return {
            content: [
              {
                type: 'text',
                text: `Appended ${linesAppended} line(s) to ${params.path}.`,
              },
            ],
            details: { path: filePath, linesAppended },
          };
        }

        // Replace mode: old_string is required
        if (params.old_string === undefined) {
          return {
            content: [
              { type: 'text', text: 'Error: old_string is required when append is not true.' },
            ],
            details: { error: 'missing_old_string' },
          };
        }

        const content = await readFile(filePath, 'utf-8');

        if (params.regex) {
          // Regex replace mode
          let pattern: RegExp;
          try {
            pattern = new RegExp(params.old_string, 'g');
          } catch {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: invalid regex pattern: ${params.old_string}`,
                },
              ],
              details: { error: 'invalid_regex' },
            };
          }

          const matches = content.match(pattern);
          const count = matches ? matches.length : 0;

          if (count === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: pattern not found in ${params.path}. Make sure the regex matches the file content.`,
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
                  text: `Error: pattern matches ${count} times in ${params.path}. Refine the regex to match exactly once.`,
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

          // Use a replacer function so new_string is treated as a literal
          // string — $ signs are not interpreted as backreferences.
          const newContent = content.replace(
            new RegExp(params.old_string),
            () => params.new_string
          );
          await writeFile(filePath, newContent, 'utf-8');

          if (params.commit_message) {
            commitIfStateDir(filePath, params.commit_message);
          }

          const matchIndex = content.search(new RegExp(params.old_string));
          const linesBefore = content.slice(0, matchIndex).split('\n').length;
          const linesChanged = params.new_string.split('\n').length;

          return {
            content: [
              {
                type: 'text',
                text: `Edited ${params.path} — replaced pattern match at line ${linesBefore} with ${linesChanged} line(s).`,
              },
            ],
            details: { path: filePath, startLine: linesBefore, linesChanged },
          };
        }

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
