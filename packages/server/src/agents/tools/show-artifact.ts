/**
 * Show Artifact Tool
 *
 * Displays an HTML artifact file in the UI left panel.
 * The file is served directly by the HTTP server, not through this tool.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, relative } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const SYSTEM2_DIR = join(homedir(), '.system2');

export function createShowArtifactTool(): AgentTool<any> {
  const params = Type.Object({
    path: Type.String({
      description:
        'Path to the HTML artifact file, relative to ~/.system2/ (e.g. "projects/myproject/artifacts/report.html")',
    }),
  });

  return {
    name: 'show_artifact',
    label: 'Show Artifact',
    description:
      'Display an HTML artifact file in the UI side panel. The file must exist under ~/.system2/. Only specify the relative path — the file content is served directly by the server.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      // Resolve and validate path (prevent traversal)
      const resolved = normalize(join(SYSTEM2_DIR, params.path));
      const rel = relative(SYSTEM2_DIR, resolved);
      if (rel.startsWith('..') || rel.startsWith('/')) {
        return {
          content: [
            { type: 'text', text: `Error: path must be within ~/.system2/: ${params.path}` },
          ],
          details: { error: 'path_traversal', path: params.path },
        };
      }

      // Check file exists
      if (!existsSync(resolved)) {
        return {
          content: [{ type: 'text', text: `Error: artifact not found: ${params.path}` }],
          details: { error: 'not_found', path: params.path },
        };
      }

      const url = `/artifacts/${rel}`;

      return {
        content: [{ type: 'text', text: 'Artifact displayed' }],
        details: { url, absolutePath: resolved },
      };
    },
  };
}
