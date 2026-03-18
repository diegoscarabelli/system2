/**
 * One-Shot LLM Utility
 *
 * Lightweight wrapper around pi-ai's completeSimple for single-turn LLM calls.
 * Used for tasks like summarizing user-agent interactions (ConversationSummarizer).
 */

import { type Api, completeSimple, type Model } from '@mariozechner/pi-ai';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';

export interface OneShotOptions {
  systemPrompt?: string;
  userMessage: string;
  signal?: AbortSignal;
}

/**
 * Execute a single-turn LLM call and return the text response.
 *
 * @param modelRegistry - Registry for API key resolution
 * @param model - The model to use (e.g., narrator's model for cheap summarization)
 * @param options - System prompt, user message, and optional abort signal
 * @returns The model's text response
 */
export async function oneShotComplete(
  modelRegistry: ModelRegistry,
  model: Model<Api>,
  options: OneShotOptions
): Promise<string> {
  const apiKey = await modelRegistry.getApiKey(model);

  const result = await completeSimple(
    model,
    {
      systemPrompt: options.systemPrompt,
      messages: [
        {
          role: 'user',
          content: options.userMessage,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      signal: options.signal,
    }
  );

  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}
