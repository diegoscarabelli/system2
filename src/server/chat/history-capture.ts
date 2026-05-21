/**
 * History Capture
 *
 * Creates an event subscriber that captures agent session events into a
 * MessageHistory (chat cache). Extracted from Server so the logic is testable
 * independently.
 *
 * Everything visible as a chat row lives in chatCache — including the partial
 * assistant turn that errored, the LLM-error system row, and compaction
 * notices. The UI receives these live via the chatCache's push listener
 * (WebSocketHandler forwards each push as chat_message_added), so there is no
 * UI-side synthesis of these rows.
 */

import { randomUUID } from 'node:crypto';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { ChatMessage, ChatTurnEvent } from '../../shared/index.js';
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
 *
 * Returns `{ subscriber, flushPartial }`. The subscriber goes to AgentHost.
 * `flushPartial` is a server-side hook used by WebSocketHandler during a
 * steering message: it captures whatever the in-flight turn has accumulated
 * so far and pushes it into chatCache BEFORE the user's steering row is
 * pushed. Without this, the steer's interrupt and the user-message push race,
 * leaving chatCache in [user_steering, partial_assistant] order — chronologically
 * wrong. After flushPartial fires, the SDK's eventual message_end finds the
 * internal buffers empty and is a no-op for the partial branch (the error /
 * compaction branches still apply if relevant).
 */
export interface HistoryCapture {
  subscriber: (event: AgentSessionEvent) => void;
  flushPartial: () => void;
}

export function createHistoryCaptureSubscriber(getChatCache: () => MessageHistory): HistoryCapture {
  let currentAssistantText = '';
  let activeThinkingContent = '';
  let currentTurnEvents: ChatTurnEvent[] = [];
  // FIFO queue of tools that were still running when commitAccumulatedTurn
  // pushed them into chatCache. A later tool_execution_end whose toolName
  // matches the head of this queue belongs to a flushed message — we push a
  // follow-up assistant row carrying just the completed tool_call so the
  // result isn't dropped. Tracks {name, input} so the follow-up row preserves
  // the original invocation. FIFO match by name handles concurrent same-name
  // tools (e.g. two bash calls in flight at flush time).
  const flushedRunningTools: Array<{ name: string; input: string | undefined }> = [];

  // Shared helper: finalize active thinking into currentTurnEvents, then
  // push the accumulated turn (if any) and reset. Used by message_end AND
  // flushPartial so both honor the same "what counts as a turn" rule.
  function commitAccumulatedTurn(): void {
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
    if (currentAssistantText || currentTurnEvents.length > 0) {
      // Remember any tool calls still running at commit time so a later
      // tool_execution_end can be matched and recorded as a follow-up row.
      for (const ev of currentTurnEvents) {
        if (ev.type === 'tool_call' && ev.data.status === 'running') {
          flushedRunningTools.push({ name: ev.data.name, input: ev.data.input });
        }
      }
      const assistantMsg: ChatMessage = {
        // randomUUID rather than msg-${Date.now()}: dedup-by-id in the UI's
        // appendMessage makes id uniqueness load-bearing, and millisecond
        // resolution can collide when message_end + flushPartial fire close
        // together (e.g. steering immediately after a fast turn).
        id: `msg-${randomUUID()}`,
        role: 'assistant',
        content: currentAssistantText,
        timestamp: Date.now(),
        turnEvents: currentTurnEvents.length > 0 ? [...currentTurnEvents] : undefined,
      };
      getChatCache().push(assistantMsg);
      currentAssistantText = '';
      currentTurnEvents = [];
    }
  }

  const subscriber = (event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          currentAssistantText += event.assistantMessageEvent.delta;
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          activeThinkingContent += event.assistantMessageEvent.delta;
        }
        break;

      case 'message_end': {
        commitAccumulatedTurn();

        // Error turns surface as a system row right after the assistant's
        // partial. The row carries the full errorMessage; failover system
        // rows pushed by AgentHost.reinitializeWithProvider intentionally
        // DON'T re-embed the same text, so the chat shows the error once.
        const messageData = (
          event as unknown as { message?: { stopReason?: string; errorMessage?: string } }
        ).message;
        if (messageData?.stopReason === 'error' && messageData.errorMessage) {
          getChatCache().push({
            id: `msg-${randomUUID()}`,
            role: 'system',
            content: `LLM error\n\n${messageData.errorMessage}`,
            timestamp: Date.now(),
          });
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
        // (No commitAccumulatedTurn here: tool calls are still part of the
        // in-flight turn and should accumulate into currentTurnEvents until
        // message_end commits the whole turn.)

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

        // No match in currentTurnEvents: the tool may have been flushed mid-
        // execution (steering during tool use). If so, push a follow-up
        // assistant row carrying just the completed tool_call so the result
        // is preserved and chronologically lands AFTER the steering user row.
        if (!matched) {
          const idx = flushedRunningTools.findIndex((t) => t.name === event.toolName);
          if (idx >= 0) {
            const orig = flushedRunningTools[idx];
            flushedRunningTools.splice(idx, 1);
            getChatCache().push({
              id: `msg-${randomUUID()}`,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              turnEvents: [
                {
                  type: 'tool_call',
                  data: {
                    id: `tool-${randomUUID()}`,
                    name: event.toolName,
                    status: 'completed' as const,
                    input: orig.input,
                    result: finalResult,
                    timestamp: Date.now(),
                  },
                },
              ],
            });
          }
        }
        break;
      }

      case 'compaction_start':
        // Use randomUUID suffix to guarantee uniqueness even when start and
        // end fire in the same millisecond (silent-failure no-ops do that).
        // React keys collide otherwise and timeline items get dropped.
        getChatCache().push({
          id: `msg-compaction-start-${randomUUID()}`,
          role: 'system',
          content: 'Context compaction started',
          timestamp: Date.now(),
        });
        break;

      case 'compaction_end': {
        // Clean message on success; surface diagnostic detail only when
        // something went wrong so silent failures don't pose as successes.
        let content: string;
        if (event.aborted) {
          content = 'Context compaction aborted';
        } else if (event.errorMessage) {
          content = `Context compaction failed: ${event.errorMessage}`;
        } else if (!event.result) {
          // SDK fired compaction_end without a result and without flagging
          // abort/error. Treat as a silent no-op and surface it.
          content = 'Context compaction failed: no result (silent no-op)';
        } else {
          content = 'Context compacted';
        }
        getChatCache().push({
          id: `msg-compaction-end-${randomUUID()}`,
          role: 'system',
          content,
          timestamp: Date.now(),
        });
        break;
      }
    }
  };

  return { subscriber, flushPartial: commitAccumulatedTurn };
}
