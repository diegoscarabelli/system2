/**
 * Show Artifact Tool
 *
 * Displays an HTML artifact file in the UI left panel.
 * The file is served directly by the HTTP server, not through this tool.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const SYSTEM2_DIR = join(homedir(), '.system2');

export function createShowArtifactTool() {
  const params = Type.Object({
    path: Type.String({
      description:
        'Path to the HTML artifact file, relative to ~/.system2/ (e.g. "projects/myproject/artifacts/report.html")',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'show_artifact',
    label: 'Show Artifact',
    description:
      'Display an HTML artifact file in the UI side panel. The file must exist under ~/.system2/. Only specify the relative path — the file content is served directly by the server.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const resolved = normalize(join(SYSTEM2_DIR, params.path));

      if (!existsSync(resolved)) {
        return {
          content: [{ type: 'text', text: `Error: artifact not found: ${params.path}` }],
          details: { error: 'not_found', path: params.path },
        };
      }

      const url = `/artifacts/${params.path}`;

      return {
        content: [{ type: 'text', text: 'Artifact displayed' }],
        details: { url, absolutePath: resolved },
      };
    },
  };
  return tool;
}
