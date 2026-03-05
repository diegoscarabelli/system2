/**
 * Custom AgentMessage Types for Multi-Agent Communication
 *
 * Extends pi-agent-core via declaration merging to support
 * inter-agent communication with sender/receiver tracking.
 *
 * Note: These declarations define in-memory message types for future event routing.
 * Actual inter-agent message persistence and LLM context injection uses
 * sendCustomMessage() with customType: 'agent_message' (stored as custom_message
 * entries in JSONL). See AgentHost.deliverMessage() and the message_agent tool.
 */

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    /**
     * Emitted when an agent spawns a child agent
     */
    agent_spawn: {
      role: 'agent_spawn';
      source: string; // Spawning agent ID
      target: string; // Spawned agent ID
      childId: string; // Same as target
      timestamp: number;
    };

    /**
     * Message sent between agents
     */
    agent_message: {
      role: 'agent_message';
      source: string;
      target: string;
      content: string;
      timestamp: number;
    };

    /**
     * Result returned from a child agent to parent
     */
    agent_result: {
      role: 'agent_result';
      source: string;
      target: string;
      content: string;
      timestamp: number;
    };
  }
}

export {};
