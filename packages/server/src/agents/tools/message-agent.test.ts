import type { Agent } from '@dscarabelli/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../db/client.js';
import type { AgentRegistry } from '../registry.js';
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
  const deliverMessage = vi.fn().mockReturnValue(undefined);
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
  } as unknown as DatabaseClient;
  const registry = {
    get: (id: number) =>
      registeredIds.includes(id) ? { deliverMessage, abort: vi.fn() } : undefined,
  } as unknown as AgentRegistry;
  const tool = createMessageAgentTool(selfId, registry, db);
  return { tool, deliverMessage };
}

// Derive types from the tool so tests stay in sync with implementation
const { tool: _refTool } = setup(1, [], []);
type MessageParams = Parameters<typeof _refTool.execute>[1];
type MessageResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('message_agent tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<MessageResult> =>
    tool.execute('test', params as MessageParams);

  it('delivers a message successfully', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    const { tool, deliverMessage } = setup(1, [guide, conductor], [2]);

    const result = await exec(tool, { agent_id: 2, message: 'Hello conductor' });

    expect((result.content[0] as { text: string }).text).toContain('delivered');
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const [content] = deliverMessage.mock.calls[0];
    expect(content).toContain('[guide_1 message]');
    expect(content).toContain('Hello conductor');
  });

  it('prevents self-messaging', async () => {
    const guide = makeAgent(1, 'guide');
    const { tool } = setup(1, [guide], [1]);

    const result = await exec(tool, { agent_id: 1, message: 'Hello me' });

    expect((result.content[0] as { text: string }).text).toContain(
      'Cannot send a message to yourself'
    );
  });

  it('errors when target agent not in database', async () => {
    const guide = makeAgent(1, 'guide');
    const { tool } = setup(1, [guide], []);

    const result = await exec(tool, { agent_id: 99, message: 'Hello' });

    expect((result.content[0] as { text: string }).text).toContain('No agent found');
  });

  it('errors when target agent not active', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    conductor.status = 'archived';
    const { tool } = setup(1, [guide, conductor], []); // not registered

    const result = await exec(tool, { agent_id: 2, message: 'Hello' });

    expect((result.content[0] as { text: string }).text).toContain('not currently active');
  });

  it('returns success even when deliverMessage throws (fire-and-forget)', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    const db = {
      getAgent: (id: number) => [guide, conductor].find((a) => a.id === id) ?? null,
    } as unknown as DatabaseClient;
    const registry = {
      get: () => ({
        deliverMessage: vi.fn().mockImplementation(() => {
          throw new Error('delivery failed');
        }),
      }),
    } as unknown as AgentRegistry;
    const tool = createMessageAgentTool(1, registry, db);

    const result = await exec(tool, { agent_id: 2, message: 'Hello' });

    // deliverMessage is fire-and-forget; synchronous throws are caught by the try/catch
    expect((result.content[0] as { text: string }).text).toContain('delivery failed');
  });
});
