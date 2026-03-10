import type { Agent } from '@system2/shared';
import { describe, expect, it, vi } from 'vitest';
import { createMessageAgentTool } from './message-agent.js';

function makeAgent(id: number, role: string): Agent {
  return {
    id,
    role,
    project: null,
    status: 'active',
    created_at: 'now',
    updated_at: 'now',
  } as Agent;
}

function setup(selfId: number, agents: Agent[], registeredIds: number[]) {
  const deliverMessage = vi.fn().mockResolvedValue(undefined);
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
  } as any;
  const registry = {
    get: (id: number) =>
      registeredIds.includes(id) ? { deliverMessage, abort: vi.fn() } : undefined,
  } as any;
  const tool = createMessageAgentTool(selfId, registry, db);
  return { tool, deliverMessage };
}

describe('message_agent tool', () => {
  const exec = (tool: any, params: Record<string, unknown>) =>
    tool.execute('test', params as any) as any;

  it('delivers a message successfully', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    const { tool, deliverMessage } = setup(1, [guide, conductor], [2]);

    const result = await exec(tool, { agent_id: 2, message: 'Hello conductor' });

    expect(result.content[0].text).toContain('delivered');
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const [content] = deliverMessage.mock.calls[0];
    expect(content).toContain('[Message from guide agent (id=1)]');
    expect(content).toContain('Hello conductor');
  });

  it('prevents self-messaging', async () => {
    const guide = makeAgent(1, 'guide');
    const { tool } = setup(1, [guide], [1]);

    const result = await exec(tool, { agent_id: 1, message: 'Hello me' });

    expect(result.content[0].text).toContain('Cannot send a message to yourself');
  });

  it('errors when target agent not in database', async () => {
    const guide = makeAgent(1, 'guide');
    const { tool } = setup(1, [guide], []);

    const result = await exec(tool, { agent_id: 99, message: 'Hello' });

    expect(result.content[0].text).toContain('No agent found');
  });

  it('errors when target agent not active', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    conductor.status = 'archived';
    const { tool } = setup(1, [guide, conductor], []); // not registered

    const result = await exec(tool, { agent_id: 2, message: 'Hello' });

    expect(result.content[0].text).toContain('not currently active');
  });

  it('propagates delivery errors', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    const db = {
      getAgent: (id: number) => [guide, conductor].find((a) => a.id === id) ?? null,
    } as any;
    const registry = {
      get: () => ({
        deliverMessage: vi.fn().mockRejectedValue(new Error('delivery failed')),
      }),
    } as any;
    const tool = createMessageAgentTool(1, registry, db);

    const result = await exec(tool, { agent_id: 2, message: 'Hello' });

    expect(result.content[0].text).toContain('delivery failed');
  });
});
