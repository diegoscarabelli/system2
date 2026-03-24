import type { Agent } from '@dscarabelli/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../db/client.js';
import { createResurrectAgentTool } from './resurrect-agent.js';

function makeAgent(id: number, role: string, project: number | null, status = 'active'): Agent {
  return { id, role, project, status, created_at: 'now', updated_at: 'now' } as Agent;
}

function setup(agentId: number, agents: Agent[]) {
  const resurrector = vi.fn().mockResolvedValue(undefined);
  const updateAgentStatus = vi.fn();
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
    updateAgentStatus,
  } as unknown as DatabaseClient;
  const tool = createResurrectAgentTool(db, agentId, resurrector);
  return { tool, resurrector, updateAgentStatus };
}

// Derive types from the tool so tests stay in sync with implementation
const { tool: _refTool } = setup(1, []);
type ResurrectParams = Parameters<typeof _refTool.execute>[1];
type ResurrectResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('resurrect_agent tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<ResurrectResult> =>
    tool.execute('test', params as ResurrectParams);

  it('Guide resurrects archived agent successfully', async () => {
    const { tool, resurrector, updateAgentStatus } = setup(1, [
      makeAgent(1, 'guide', null),
      makeAgent(5, 'conductor', 10, 'archived'),
    ]);

    const result = await exec(tool, {
      agent_id: 5,
      message: 'Project restarted, resume work on data extraction.',
    });

    expect((result.content[0] as { text: string }).text).toContain('has been resurrected');
    expect(updateAgentStatus).toHaveBeenCalledWith(5, 'active');
    expect(resurrector).toHaveBeenCalledWith(
      5,
      1,
      'Project restarted, resume work on data extraction.'
    );
  });

  it('cannot resurrect already-active agent', async () => {
    const { tool } = setup(1, [
      makeAgent(1, 'guide', null),
      makeAgent(5, 'conductor', 10, 'active'),
    ]);

    const result = await exec(tool, {
      agent_id: 5,
      message: 'Resume work.',
    });

    expect((result.content[0] as { text: string }).text).toContain('already active');
  });

  it('cannot resurrect singleton guide', async () => {
    const { tool } = setup(1, [
      makeAgent(1, 'guide', null),
      makeAgent(2, 'guide', null, 'archived'),
    ]);

    const result = await exec(tool, {
      agent_id: 2,
      message: 'Resume.',
    });

    expect((result.content[0] as { text: string }).text).toContain('Cannot resurrect singleton');
  });

  it('cannot resurrect singleton narrator', async () => {
    const { tool } = setup(1, [
      makeAgent(1, 'guide', null),
      makeAgent(2, 'narrator', null, 'archived'),
    ]);

    const result = await exec(tool, {
      agent_id: 2,
      message: 'Resume.',
    });

    expect((result.content[0] as { text: string }).text).toContain('Cannot resurrect singleton');
  });

  it('Conductor resurrects archived agent within own project', async () => {
    const { tool, resurrector, updateAgentStatus } = setup(3, [
      makeAgent(3, 'conductor', 10),
      makeAgent(5, 'reviewer', 10, 'archived'),
    ]);

    const result = await exec(tool, {
      agent_id: 5,
      message: 'Resume work on code review.',
    });

    expect((result.content[0] as { text: string }).text).toContain('has been resurrected');
    expect(updateAgentStatus).toHaveBeenCalledWith(5, 'active');
    expect(resurrector).toHaveBeenCalledWith(5, 3, 'Resume work on code review.');
  });

  it('Conductor cannot resurrect agent in a different project', async () => {
    const { tool } = setup(3, [
      makeAgent(3, 'conductor', 10),
      makeAgent(5, 'reviewer', 99, 'archived'),
    ]);

    const result = await exec(tool, {
      agent_id: 5,
      message: 'Resume.',
    });

    expect((result.content[0] as { text: string }).text).toContain('own project');
  });

  it('Reviewer cannot resurrect', async () => {
    const { tool } = setup(4, [
      makeAgent(4, 'reviewer', 10),
      makeAgent(5, 'conductor', 10, 'archived'),
    ]);

    const result = await exec(tool, {
      agent_id: 5,
      message: 'Resume.',
    });

    expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
  });

  it('errors when agent not found', async () => {
    const { tool } = setup(1, [makeAgent(1, 'guide', null)]);

    const result = await exec(tool, {
      agent_id: 999,
      message: 'Resume.',
    });

    expect((result.content[0] as { text: string }).text).toContain('not found');
  });

  it('rolls back DB status on resurrector failure', async () => {
    const { tool, resurrector, updateAgentStatus } = setup(1, [
      makeAgent(1, 'guide', null),
      makeAgent(5, 'conductor', 10, 'archived'),
    ]);
    resurrector.mockRejectedValue(new Error('session init failed'));

    const result = await exec(tool, {
      agent_id: 5,
      message: 'Resume.',
    });

    expect((result.content[0] as { text: string }).text).toContain('session init failed');
    // First call sets active, second call rolls back to archived
    expect(updateAgentStatus).toHaveBeenCalledWith(5, 'active');
    expect(updateAgentStatus).toHaveBeenCalledWith(5, 'archived');
  });
});
