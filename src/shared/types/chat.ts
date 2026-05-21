/**
 * Chat Message Types
 *
 * Shared types for chat messages displayed in the UI.
 * Used by both the server (MessageHistory) and the UI (chat store).
 */

export interface ChatToolCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  input?: string;
  result?: string;
  progressMessage?: string;
  timestamp: number;
}

export interface ChatThinkingBlock {
  id: string;
  content: string;
  isStreaming: boolean;
  timestamp: number;
}

export type ChatTurnEvent =
  | { type: 'thinking'; data: ChatThinkingBlock }
  | { type: 'tool_call'; data: ChatToolCall };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  turnEvents?: ChatTurnEvent[];
  /**
   * True for assistant rows that did NOT finalize a streaming turn. Currently
   * set by `history-capture` on the tool-completion follow-up row pushed when
   * a tool that was running at `flushPartial` time fires its
   * `tool_execution_end` later. By the time that row arrives in the UI, the
   * next (steered) turn may already be streaming; the UI uses this flag to
   * append the row WITHOUT clearing the in-flight streaming draft. Real
   * turn-end rows leave this undefined/false so the draft is cleared as usual.
   */
  isFollowUp?: boolean;
}
