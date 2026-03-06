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
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  turnEvents?: ChatTurnEvent[];
}
