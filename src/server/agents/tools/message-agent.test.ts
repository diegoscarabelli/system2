import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../shared/index.js';
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

function setup(
  selfId: number,
  agents: Agent[],
  registeredIds: number[],
  maxDeliveryBytes?: number
) {
  const deliverMessage = vi.fn().mockReturnValue(Promise.resolve());
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
  } as unknown as DatabaseClient;
  const registry = {
    get: (id: number) =>
      registeredIds.includes(id) ? { deliverMessage, abort: vi.fn() } : undefined,
  } as unknown as AgentRegistry;
  const tool = createMessageAgentTool(selfId, registry, db, maxDeliveryBytes);
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

  it('returns error tool-result when message exceeds maxDeliveryBytes cap', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    // Cap set to 50 bytes — well below any realistic message
    const { tool, deliverMessage } = setup(1, [guide, conductor], [2], 50);

    const result = await exec(tool, { agent_id: 2, message: 'x'.repeat(200) });

    expect((result.details as { error: string }).error).toBe('message_too_large');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('exceeds the inter-agent delivery cap');
    expect(text).toContain('50'); // cap mentioned in error
    // deliverMessage must NOT have been called
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('calls deliverMessage when message is within maxDeliveryBytes cap', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    // Cap set to 1 MB — comfortably above a small message
    const { tool, deliverMessage } = setup(1, [guide, conductor], [2], 1024 * 1024);

    const result = await exec(tool, { agent_id: 2, message: 'small message' });

    expect((result.content[0] as { text: string }).text).toContain('delivered');
    expect(deliverMessage).toHaveBeenCalledTimes(1);
  });

  it('size pre-check accounts for the sender prefix overhead', async () => {
    const guide = makeAgent(1, 'guide');
    const conductor = makeAgent(2, 'conductor');
    // The tool prepends "[guide_1 message]\n\n" (~20 bytes) before measuring.
    // Set cap to exactly the prefix length so any non-empty message fails.
    const prefix = '[guide_1 message]\n\n';
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    const { tool, deliverMessage } = setup(1, [guide, conductor], [2], prefixBytes);

    // A non-empty message should overflow the cap
    const result = await exec(tool, { agent_id: 2, message: 'hi' });
    expect((result.details as { error: string }).error).toBe('message_too_large');
    expect(deliverMessage).not.toHaveBeenCalled();
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
