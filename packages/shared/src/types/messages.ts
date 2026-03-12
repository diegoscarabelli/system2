/**
 * WebSocket Protocol Types
 *
 * Defines the message format for client-server communication over WebSocket.
 */

import type { ChatMessage } from './chat.js';

// Client -> Server messages
export type ClientMessage =
  | { type: 'user_message'; content: string }
  | { type: 'steering_message'; content: string } // Steering messages are inserted ASAP into the agent loop
  | { type: 'abort' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'assistant_chunk'; content: string }
  | { type: 'assistant_end' }
  | { type: 'thinking_chunk'; content: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call_start'; name: string; input?: string }
  | { type: 'tool_call_end'; name: string; result: string }
  | { type: 'artifact'; url: string; title?: string; filePath?: string }
  | { type: 'context_usage'; percent: number | null; tokens: number | null; contextWindow: number }
  | { type: 'error'; message: string }
  | { type: 'ready_for_input' } // Signals that the agent is ready for the next message
  | { type: 'chat_history'; messages: ChatMessage[] } // Sent on connect — recent message history from server
  | { type: 'user_message_broadcast'; id: string; content: string; timestamp: number } // Broadcast to other tabs
  | { type: 'provider_info'; provider: string } // Sent on connect — current LLM provider
  | { type: 'provider_change'; provider: string } // Sent on failover — provider switched
  | { type: 'catalog_changed' } // Sent when artifact catalog entries are created/updated/deleted
  | { type: 'agents_changed'; context: Record<number, number | null> }; // Sent when any agent's busy state changes; context maps agentId -> contextPercent
