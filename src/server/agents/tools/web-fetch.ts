/**
 * Web Fetch Tool
 *
 * Fetches a URL and extracts readable content using Mozilla Readability.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Readability } from '@mozilla/readability';
import { Type } from '@sinclair/typebox';
import { parseHTML } from 'linkedom';

const DEFAULT_MAX_LENGTH = 20_000;
const FETCH_TIMEOUT = 15_000; // 15 seconds

export function createWebFetchTool() {
  const params = Type.Object({
    url: Type.String({
      description: 'The URL to fetch and extract content from',
    }),
    max_length: Type.Optional(
      Type.Number({
        description: `Maximum character length of returned content (default: ${DEFAULT_MAX_LENGTH})`,
      })
    ),
  });

  const tool: AgentTool<typeof params> = {
    name: 'web_fetch',
    label: 'Fetch Web Page',
    description:
      'Fetch a web page and extract its main content as readable text. Strips navigation, ads, and boilerplate. Use web_search first to find URLs, then web_fetch to read specific pages.',
    parameters: params,
    execute: async (_toolCallId, params, signal, _onUpdate) => {
      const maxLength = params.max_length ?? DEFAULT_MAX_LENGTH;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        if (signal) {
          signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        let response: Response;
        try {
          response = await fetch(params.url, {
            headers: {
              'User-Agent': 'System2/1.0 (Web Fetch Tool)',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: controller.signal,
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Fetch failed (${response.status}): ${response.statusText}`,
              },
            ],
            details: { error: response.statusText, status: response.status, url: params.url },
          };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('html') && !contentType.includes('xml')) {
          return {
            content: [
              {
                type: 'text',
                text: `Cannot extract text: content type is ${contentType}. Only HTML pages are supported.`,
              },
            ],
            details: { error: 'unsupported_content_type', contentType, url: params.url },
          };
        }

        const html = await response.text();

        const { document } = parseHTML(html);

        const reader = new Readability(document);
        const article = reader.parse();

        if (!article?.textContent?.trim()) {
          const { document: fallbackDoc } = parseHTML(html);
          for (const tag of ['script', 'style', 'nav', 'header', 'footer']) {
            for (const el of fallbackDoc.querySelectorAll(tag)) {
              el.remove();
            }
          }
          let text = (fallbackDoc.body?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length > maxLength) {
            text = `${text.substring(0, maxLength)}\n\n[Content truncated]`;
          }
          return {
            content: [{ type: 'text', text: text || 'Could not extract content from page.' }],
            details: { url: params.url, length: text.length, method: 'fallback' },
          };
        }

        let content = article.textContent.replace(/\s+/g, ' ').trim();
        const title = article.title;

        if (content.length > maxLength) {
          content = `${content.substring(0, maxLength)}\n\n[Content truncated]`;
        }

        const output = title ? `# ${title}\n\n${content}` : content;

        return {
          content: [{ type: 'text', text: output }],
          details: { url: params.url, title, length: content.length, method: 'readability' },
        };
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        const errorMsg =
          err.name === 'AbortError' ? 'Request timed out' : err.message || String(error);
        return {
          content: [{ type: 'text', text: `Fetch failed: ${errorMsg}` }],
          details: { error: errorMsg, url: params.url },
        };
      }
    },
  };
  return tool;
}
