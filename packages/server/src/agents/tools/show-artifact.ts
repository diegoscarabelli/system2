/**
 * Show Artifact Tool
 *
 * Displays an artifact file in the UI panel. The file can live anywhere
 * on the filesystem. If the artifact is registered in the database,
 * its title is included in the response for the UI tab label.
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';
import { isTildePath, resolvePath } from './resolve-path.js';

export function createShowArtifactTool(db: DatabaseClient) {
  const params = Type.Object({
    file_path: Type.String({
      description:
        'Absolute path to the artifact file (e.g. "/home/user/reports/dashboard.html"). Supports ~/ prefix for home directory.',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'show_artifact',
    label: 'Show Artifact',
    description:
      'Display an artifact file in the UI panel. The file can be anywhere on the filesystem — specify an absolute path. If the artifact is registered in the database, its title is used for the tab label.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      // Reject bare relative paths — require absolute or ~/ prefix
      if (!isAbsolute(params.file_path) && !isTildePath(params.file_path)) {
        return {
          content: [
            { type: 'text', text: `Error: file_path must be absolute: ${params.file_path}` },
          ],
          details: { error: 'invalid_path', path: params.file_path },
        };
      }

      // Resolve path (handle ~/ expansion)
      const resolved = normalize(resolvePath(params.file_path));

      // Look up metadata in DB
      const artifact = db.getArtifactByPath(resolved);
      const title = artifact?.title ?? basename(resolved);

      if (!existsSync(resolved)) {
        const msg = artifact
          ? `Error: registered artifact "${artifact.title}" not found at: ${resolved}. The file may have been moved — try searching for "${basename(resolved)}" to locate it.`
          : `Error: artifact not found: ${resolved}`;
        return {
          content: [{ type: 'text', text: msg }],
          details: { error: 'not_found', path: resolved },
        };
      }

      const url = `/api/artifact?path=${encodeURIComponent(resolved)}`;

      return {
        content: [{ type: 'text', text: 'Artifact displayed' }],
        details: { url, absolutePath: resolved, title },
      };
    },
  };
  return tool;
}
