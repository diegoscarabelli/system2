import type { Agent } from '@dscarabelli/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../db/client.js';
import type { AgentRegistry } from '../registry.js';
import { createTerminateAgentTool } from './terminate-agent.js';

function makeAgent(id: number, role: string, project: number | null): Agent {
  return { id, role, project, status: 'active', created_at: 'now', updated_at: 'now' } as Agent;
}

function setup(callerId: number, agents: Agent[], registeredIds: number[]) {
  const abort = vi.fn();
  const unregister = vi.fn();
  const updateAgentStatus = vi.fn();
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
    updateAgentStatus,
  } as unknown as DatabaseClient;
  const registry = {
    get: (id: number) => (registeredIds.includes(id) ? { abort } : undefined),
    unregister,
  } as unknown as AgentRegistry;
  const tool = createTerminateAgentTool(db, callerId, registry);
  return { tool, abort, unregister, updateAgentStatus };
}

// Derive types from the tool so tests stay in sync with implementation
const { tool: _refTool } = setup(1, [], []);
type TerminateParams = Parameters<typeof _refTool.execute>[1];
type TerminateResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('terminate_agent tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<TerminateResult> =>
    tool.execute('test', params as TerminateParams);

  it('Guide terminates conductor', async () => {
    const guide = makeAgent(1, 'guide', null);
    const conductor = makeAgent(2, 'conductor', 10);
    const { tool, abort, unregister, updateAgentStatus } = setup(1, [guide, conductor], [2]);

    const result = await exec(tool, { agent_id: 2 });

    expect((result.content[0] as { text: string }).text).toContain('terminated and archived');
    expect(updateAgentStatus).toHaveBeenCalledWith(2, 'archived');
    expect(abort).toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledWith(2);
  });

  it('Conductor terminates agent in own project', async () => {
    const conductor = makeAgent(2, 'conductor', 10);
    const reviewer = makeAgent(3, 'reviewer', 10);
    const { tool } = setup(2, [conductor, reviewer], [3]);

    const result = await exec(tool, { agent_id: 3 });

    expect((result.content[0] as { text: string }).text).toContain('terminated');
  });

  it('Conductor cannot terminate agent in other project', async () => {
    const conductor = makeAgent(2, 'conductor', 10);
    const other = makeAgent(3, 'conductor', 20);
    const { tool } = setup(2, [conductor, other], [3]);

    const result = await exec(tool, { agent_id: 3 });

    expect((result.content[0] as { text: string }).text).toContain(
      'only terminate agents in their own project'
    );
  });

  it('prevents self-termination', async () => {
    const conductor = makeAgent(2, 'conductor', 10);
    const { tool } = setup(2, [conductor], [2]);

    const result = await exec(tool, { agent_id: 2 });

    expect((result.content[0] as { text: string }).text).toContain('cannot terminate itself');
  });

  it('prevents terminating singleton (guide)', async () => {
    const guide = makeAgent(1, 'guide', null);
    const conductor = makeAgent(2, 'conductor', 10);
    const { tool } = setup(2, [guide, conductor], [1]);

    const result = await exec(tool, { agent_id: 1 });

    expect((result.content[0] as { text: string }).text).toContain('singleton');
  });

  it('prevents terminating singleton (narrator)', async () => {
    const narrator = makeAgent(3, 'narrator', null);
    const guide = makeAgent(1, 'guide', null);
    const { tool } = setup(1, [guide, narrator], [3]);

    const result = await exec(tool, { agent_id: 3 });

    expect((result.content[0] as { text: string }).text).toContain('singleton');
  });

  it('Conductor terminates worker in own project', async () => {
    const conductor = makeAgent(2, 'conductor', 10);
    const worker = makeAgent(4, 'worker', 10);
    const { tool, updateAgentStatus } = setup(2, [conductor, worker], [4]);

    const result = await exec(tool, { agent_id: 4 });

    expect((result.content[0] as { text: string }).text).toContain('terminated');
    expect(updateAgentStatus).toHaveBeenCalledWith(4, 'archived');
  });

  it('Worker cannot terminate agents', async () => {
    const worker = makeAgent(4, 'worker', 10);
    const conductor = makeAgent(2, 'conductor', 10);
    const { tool } = setup(4, [worker, conductor], [2]);

    const result = await exec(tool, { agent_id: 2 });

    expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
  });

  it('errors for unauthorized role (reviewer)', async () => {
    const reviewer = makeAgent(3, 'reviewer', 10);
    const conductor = makeAgent(2, 'conductor', 10);
    const { tool } = setup(3, [reviewer, conductor], [2]);

    const result = await exec(tool, { agent_id: 2 });

    expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
  });

  it('errors when target not found', async () => {
    const guide = makeAgent(1, 'guide', null);
    const { tool } = setup(1, [guide], []);

    const result = await exec(tool, { agent_id: 99 });

    expect((result.content[0] as { text: string }).text).toContain('not found');
  });

  it('succeeds even when onTerminate callback throws', async () => {
    const guide = makeAgent(1, 'guide', null);
    const conductor = makeAgent(2, 'conductor', 10);
    const abort = vi.fn();
    const unregister = vi.fn();
    const updateAgentStatus = vi.fn();
    const db = {
      getAgent: (id: number) => [guide, conductor].find((a) => a.id === id) ?? null,
      updateAgentStatus,
    } as unknown as DatabaseClient;
    const registry = {
      get: () => ({ abort }),
      unregister,
    } as unknown as AgentRegistry;
    const onTerminate = vi.fn(() => {
      throw new Error('broadcast failed');
    });
    const tool = createTerminateAgentTool(db, 1, registry, onTerminate);

    const result = await tool.execute('test', { agent_id: 2 } as TerminateParams);

    // Termination completed despite callback throwing
    expect((result.content[0] as { text: string }).text).toContain('terminated and archived');
    expect(updateAgentStatus).toHaveBeenCalledWith(2, 'archived');
    expect(onTerminate).toHaveBeenCalled();
  });
});
