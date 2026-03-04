/**
 * Web Search Tool
 *
 * Searches the web using the Brave Search API and returns structured results.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

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

export function createWebSearchTool(apiKey: string, maxResults?: number): AgentTool<any> {
  const defaultCount = maxResults ?? DEFAULT_MAX_RESULTS;

  const params = Type.Object({
    query: Type.String({
      description: 'The search query',
    }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results to return (default: ${defaultCount}, max: 20)`,
      })
    ),
  });

  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web using Brave Search and return structured results with title, URL, and description.',
    parameters: params,
    execute: async (_toolCallId, params, signal, _onUpdate) => {
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
      } catch (error: any) {
        const errorMsg =
          error.name === 'AbortError' ? 'Search aborted' : error.message || String(error);
        return {
          content: [{ type: 'text', text: `Search failed: ${errorMsg}` }],
          details: { error: errorMsg },
        };
      }
    },
  };
}
