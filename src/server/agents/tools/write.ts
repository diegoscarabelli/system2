/**
 * Write Tool
 *
 * Writes content to files on the filesystem.
 * Refuses to overwrite existing files that contain data. To replace an
 * existing file, delete it first (via bash `rm`), then write.
 */

import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { commitIfStateDir } from './git-commit.js';
import { resolvePath } from './resolve-path.js';

/** Max bytes of existing content to include in the blocked-overwrite preview. */
const PREVIEW_BYTES = 200;

/**
 * Returns true for files inside ~/.system2/ whose content may contain API keys
 * or other credentials. Content previews are suppressed for these paths.
 * Note: symlinks are not resolved; paths are assumed to be absolute and
 * already normalized (as produced by resolvePath()).
 */
export function isSensitivePath(filePath: string): boolean {
  const stateDir = join(homedir(), '.system2') + sep;
  return resolve(filePath).startsWith(stateDir);
}

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
      'Create a new file or write to an empty file. Creates parent directories if needed. ' +
      'This tool REFUSES to overwrite an existing file that already contains data. ' +
      'To modify part of a file, use the `edit` tool. ' +
      'To append content (e.g. adding a [databases.<name>] entry to config.toml), use `edit` with `append: true`. ' +
      'To intentionally replace a file entirely, delete it first with `bash` (`rm <path>`), then use this tool. ' +
      'For bulk find-and-replace, use `bash` with `sed` or `awk`.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        const filePath = resolvePath(params.path);

        // Block overwriting existing files that contain data
        try {
          const stats = await stat(filePath);
          if (stats.isFile() && stats.size > 0) {
            let previewSection = '';
            if (!isSensitivePath(filePath)) {
              // Read only the first PREVIEW_BYTES to avoid loading large files
              const bytesToRead = Math.min(stats.size, PREVIEW_BYTES);
              const buf = Buffer.alloc(bytesToRead);
              const fh = await open(filePath, 'r');
              try {
                await fh.read(buf, 0, bytesToRead, 0);
              } finally {
                await fh.close();
              }
              // StringDecoder handles incomplete multi-byte sequences at the boundary
              const decoder = new StringDecoder('utf8');
              const preview = decoder.write(buf);
              const suffix = stats.size > PREVIEW_BYTES ? '...' : '';
              previewSection = `\n\nExisting content starts with:\n${preview}${suffix}`;
            }
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `Cannot write: file already exists with content (${stats.size} bytes). ` +
                    `Use the \`edit\` tool to modify it, or delete it first (\`bash\`: \`rm ${params.path}\`) ` +
                    `then retry this write.${previewSection}`,
                },
              ],
              details: { path: filePath, blocked: true, existingSize: stats.size },
            };
          }
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // File doesn't exist, safe to write
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
