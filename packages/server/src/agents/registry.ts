/**
 * Agent Registry
 *
 * Central registry mapping agent database IDs to their AgentHost instances.
 * Enables inter-agent message routing via the message_agent tool.
 */

import type { AgentHost } from './host.js';

export class AgentRegistry {
  private agents: Map<number, AgentHost> = new Map();

  /** Register an agent host with its database ID */
  register(agentId: number, host: AgentHost): void {
    this.agents.set(agentId, host);
  }

  /** Unregister an agent by database ID */
  unregister(agentId: number): void {
    this.agents.delete(agentId);
  }

  /** Look up an agent host by database ID */
  get(agentId: number): AgentHost | undefined {
    return this.agents.get(agentId);
  }

  /** Check if an agent is registered */
  has(agentId: number): boolean {
    return this.agents.has(agentId);
  }

  /** List all registered agent IDs */
  listIds(): number[] {
    return Array.from(this.agents.keys());
  }

  /** Iterate over all [id, host] pairs */
  entries(): IterableIterator<[number, AgentHost]> {
    return this.agents.entries();
  }
}
