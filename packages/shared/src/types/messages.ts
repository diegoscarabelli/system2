/**
 * WebSocket Protocol Types
 *
 * Defines the message format for client-server communication over WebSocket.
 */

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
  | { type: 'artifact'; url: string }
  | { type: 'context_usage'; percent: number | null; tokens: number | null; contextWindow: number }
  | { type: 'error'; message: string }
  | { type: 'ready_for_input' }; // Signals that the agent is ready for the next message
