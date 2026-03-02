/**
 * Custom AgentMessage Types for Multi-Agent Communication
 *
 * Extends pi-agent-core via declaration merging to support
 * inter-agent communication with source/target tracking.
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
