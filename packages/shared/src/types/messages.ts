/**
 * WebSocket Protocol Types
 *
 * Defines the message format for client-server communication over WebSocket.
 */

import type { ChatMessage } from './chat.js';

// Client -> Server messages
// agentId is optional on user/steering/abort: when absent, defaults to the Guide agent.
export type ClientMessage =
  | { type: 'user_message'; content: string; agentId?: number }
  | { type: 'steering_message'; content: string; agentId?: number } // Steering messages are inserted ASAP into the agent loop
  | { type: 'abort'; agentId?: number }
  | { type: 'switch_agent'; agentId: number }; // Switch the active chat to a different agent

// Server -> Client messages
// agentId is optional on streaming messages: when absent, implies the Guide agent.
export type ServerMessage =
  | { type: 'assistant_chunk'; content: string; agentId?: number }
  | { type: 'assistant_end'; agentId?: number; errorMessage?: string }
  | { type: 'thinking_chunk'; content: string; agentId?: number }
  | { type: 'thinking_end'; agentId?: number }
  | { type: 'tool_call_start'; name: string; input?: string; agentId?: number }
  | { type: 'tool_call_end'; name: string; result: string; agentId?: number }
  | { type: 'artifact'; url: string; title?: string; filePath?: string }
  | {
      type: 'context_usage';
      percent: number | null;
      tokens: number | null;
      contextWindow: number;
      agentId?: number;
    }
  | { type: 'error'; message: string; agentId?: number }
  | { type: 'ready_for_input'; agentId?: number } // Signals that the agent is ready for the next message
  | { type: 'chat_history'; messages: ChatMessage[]; agentId: number } // Sent on connect and agent switch
  | {
      type: 'user_message_broadcast';
      id: string;
      content: string;
      timestamp: number;
      agentId?: number;
    }
  | { type: 'provider_info'; provider: string; agentId: number } // Sent on connect/switch — current LLM provider for an agent
  | { type: 'provider_change'; provider: string; reason?: string; agentId: number } // Sent on failover — provider switched
  | { type: 'compaction_start'; agentId?: number } // Sent when auto-compaction begins
  | { type: 'compaction_end'; agentId?: number } // Sent when auto-compaction completes
  // Push notifications: tell UI panels to refetch data
  | { type: 'board_changed' } // Kanban data changed (projects/tasks/links/comments)
  | { type: 'agents_changed' } // Agent list changed (spawn/terminate/resurrect)
  | { type: 'artifacts_changed' } // Artifact catalog changed
  | { type: 'job_executions_changed' } // Scheduler job execution changed
  | {
      type: 'agent_busy_changed';
      agentId: number;
      busy: boolean;
      contextPercent: number | null;
    }; // Agent busy state or context usage changed
