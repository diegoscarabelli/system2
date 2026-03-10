import type { Agent, Project } from '@system2/shared';
import { describe, expect, it, vi } from 'vitest';
import { createSpawnAgentTool } from './spawn-agent.js';

function makeAgent(id: number, role: string, project: number | null): Agent {
  return { id, role, project, status: 'active', created_at: 'now', updated_at: 'now' } as Agent;
}

function makeProject(id: number): Project {
  return {
    id,
    name: 'Project',
    description: 'Desc',
    status: 'todo',
    labels: '[]',
    start_at: null,
    end_at: null,
    created_at: 'now',
    updated_at: 'now',
  } as any;
}

function setup(agentId: number, agents: Agent[], projects: Project[]) {
  const spawner = vi.fn().mockResolvedValue(42);
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
    getProject: (id: number) => projects.find((p) => p.id === id) ?? null,
  } as any;
  const tool = createSpawnAgentTool(db, agentId, spawner);
  return { tool, spawner };
}

describe('spawn_agent tool', () => {
  const exec = (tool: any, params: Record<string, unknown>) =>
    tool.execute('test', params as any) as any;

  it('Guide spawns conductor successfully', async () => {
    const { tool, spawner } = setup(1, [makeAgent(1, 'guide', null)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 10,
      initial_message: 'Start work',
    });

    expect(result.content[0].text).toContain('Agent spawned');
    expect(result.content[0].text).toContain('42');
    expect(spawner).toHaveBeenCalledWith('conductor', 10, 1, 'Start work');
  });

  it('Conductor spawns in own project', async () => {
    const { tool } = setup(2, [makeAgent(2, 'conductor', 10)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'reviewer',
      project_id: 10,
      initial_message: 'Review work',
    });

    expect(result.content[0].text).toContain('Agent spawned');
  });

  it('Conductor cannot spawn in other project', async () => {
    const { tool } = setup(2, [makeAgent(2, 'conductor', 10)], [makeProject(20)]);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 20,
      initial_message: 'x',
    });

    expect(result.content[0].text).toContain('only spawn agents within their own project');
  });

  it('Reviewer cannot spawn', async () => {
    const { tool } = setup(3, [makeAgent(3, 'reviewer', 10)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 10,
      initial_message: 'x',
    });

    expect(result.content[0].text).toContain('Only Guide and Conductor');
  });

  it('errors when project not found', async () => {
    const { tool } = setup(1, [makeAgent(1, 'guide', null)], []);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 999,
      initial_message: 'x',
    });

    expect(result.content[0].text).toContain('not found');
  });

  it('propagates spawner errors', async () => {
    const { tool, spawner } = setup(1, [makeAgent(1, 'guide', null)], [makeProject(10)]);
    spawner.mockRejectedValue(new Error('spawn failed'));

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 10,
      initial_message: 'x',
    });

    expect(result.content[0].text).toContain('spawn failed');
  });
});
