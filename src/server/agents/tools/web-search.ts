/**
 * Web Search Tool
 *
 * Searches the web using the Brave Search API and returns structured results.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';

const DEFAULT_MAX_RESULTS = 5;

interface BraveSearchApiResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
}

export function createWebSearchTool(apiKey: string, maxResults?: number) {
  const defaultCount = maxResults ?? DEFAULT_MAX_RESULTS;

  const webSearchParams = Type.Object({
    query: Type.String({
      description: 'The search query',
    }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results to return (default: ${defaultCount}, max: 20)`,
      })
    ),
  });

  const tool: AgentTool<typeof webSearchParams> = {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web using Brave Search and return structured results with title, URL, and description.',
    parameters: webSearchParams,
    execute: async (_toolCallId, rawParams, signal, _onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof webSearchParams>;
      const count = Math.min(params.count ?? defaultCount, 20);
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`;

      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              { type: 'text', text: `Search API error (${response.status}): ${errorText}` },
            ],
            details: { error: errorText, status: response.status },
          };
        }

        const data = (await response.json()) as BraveSearchApiResponse;
        const results = (data.web?.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
        }));

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No results found.' }],
            details: { query: params.query, count: 0 },
          };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
          .join('\n\n');

        return {
          content: [{ type: 'text', text: formatted }],
          details: { query: params.query, count: results.length, results },
        };
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        const errorMsg =
          err.name === 'AbortError' ? 'Search aborted' : err.message || String(error);
        return {
          content: [{ type: 'text', text: `Search failed: ${errorMsg}` }],
          details: { error: errorMsg },
        };
      }
    },
  };
  return tool;
}
