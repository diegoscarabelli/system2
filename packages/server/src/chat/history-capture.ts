/**
 * History Capture
 *
 * Creates an event subscriber that captures agent session events into a
 * MessageHistory (chat cache). Extracted from Server so the logic is testable
 * independently.
 */

import type { ChatMessage, ChatTurnEvent } from '@dscarabelli/shared';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { MessageHistory } from './history.js';

/**
 * Create a subscriber function that captures agent events into the chat cache.
 *
 * Accepts a getter so the cache is resolved lazily on the first event, not at
 * subscription time. This is important because subscriptions are set up before
 * AgentHost.initialize() (to avoid missing events), but chatCache is only
 * available after initialize() creates the MessageHistory instance.
 *
 * Accumulates thinking blocks and tool calls as turn events, then persists
 * the complete assistant message on message_end. Tool-only turns (thinking +
 * tool calls without text) are also persisted. Compaction events are recorded
 * as system messages.
 */
export function createHistoryCaptureSubscriber(
  getChatCache: () => MessageHistory
): (event: AgentSessionEvent) => void {
  let currentAssistantText = '';
  let activeThinkingContent = '';
  let currentTurnEvents: ChatTurnEvent[] = [];

  return (event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          currentAssistantText += event.assistantMessageEvent.delta;
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          activeThinkingContent += event.assistantMessageEvent.delta;
        }
        break;

      case 'message_end': {
        // Finalize thinking if active
        if (activeThinkingContent) {
          currentTurnEvents.push({
            type: 'thinking',
            data: {
              id: `thinking-${Date.now()}`,
              content: activeThinkingContent,
              isStreaming: false,
              timestamp: Date.now(),
            },
          });
          activeThinkingContent = '';
        }

        // Capture completed assistant message in history.
        // Push when there's text OR tool-only turns (thinking + tool calls without text).
        if (currentAssistantText || currentTurnEvents.length > 0) {
          const assistantMsg: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: 'assistant',
            content: currentAssistantText,
            timestamp: Date.now(),
            turnEvents: currentTurnEvents.length > 0 ? [...currentTurnEvents] : undefined,
          };
          getChatCache().push(assistantMsg);
          currentAssistantText = '';
          currentTurnEvents = [];
        }
        break;
      }

      case 'tool_execution_start': {
        // Finalize thinking before tool call
        if (activeThinkingContent) {
          currentTurnEvents.push({
            type: 'thinking',
            data: {
              id: `thinking-${Date.now()}`,
              content: activeThinkingContent,
              isStreaming: false,
              timestamp: Date.now(),
            },
          });
          activeThinkingContent = '';
        }

        // Format tool input for display
        let inputText = '';
        const rawInput = event.args;
        if (rawInput) {
          try {
            inputText = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2);
          } catch {
            inputText = String(rawInput);
          }
        }

        currentTurnEvents.push({
          type: 'tool_call',
          data: {
            id: `tool-${Date.now()}`,
            name: event.toolName,
            status: 'running',
            input: inputText,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case 'tool_execution_end': {
        // Format result as string for display
        let resultText = '';
        if (event.result?.content) {
          resultText = event.result.content
            .map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : ''))
            .join('');
        }
        const finalResult = event.isError ? `Error: ${resultText}` : resultText;

        // Update the tool call in turn events (immutable)
        let matched = false;
        currentTurnEvents = currentTurnEvents.map((e) => {
          if (
            !matched &&
            e.type === 'tool_call' &&
            e.data.name === event.toolName &&
            e.data.status === 'running'
          ) {
            matched = true;
            return {
              ...e,
              data: { ...e.data, status: 'completed' as const, result: finalResult },
            };
          }
          return e;
        });
        break;
      }

      case 'compaction_start':
      case 'compaction_end':
        getChatCache().push({
          id: `msg-${Date.now()}`,
          role: 'system',
          content:
            event.type === 'compaction_start' ? 'Context compaction started' : 'Context compacted',
          timestamp: Date.now(),
        });
        break;
    }
  };
}
