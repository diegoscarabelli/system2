import { describe, expect, it, vi } from 'vitest';
import type { Agent, Project } from '../../../shared/index.js';
import type { DatabaseClient } from '../../db/client.js';
import { createSpawnAgentTool } from './spawn-agent.js';

function makeAgent(id: number, role: string, project: number | null): Agent {
  return { id, role, project, status: 'active', created_at: 'now', updated_at: 'now' } as Agent;
}

function makeProject(id: number): Project {
  return {
    id,
    name: 'Project',
    description: 'Desc',
    dir_name: `${id}_project`,
    status: 'todo',
    labels: '[]',
    start_at: null,
    end_at: null,
    created_at: 'now',
    updated_at: 'now',
  } as unknown as Project;
}

function setup(agentId: number, agents: Agent[], projects: Project[]) {
  const spawner = vi.fn().mockResolvedValue(42);
  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
    getProject: (id: number) => projects.find((p) => p.id === id) ?? null,
  } as unknown as DatabaseClient;
  const tool = createSpawnAgentTool(db, agentId, spawner);
  return { tool, spawner };
}

// Derive types from the tool so tests stay in sync with implementation
const { tool: _refTool } = setup(1, [], []);
type SpawnParams = Parameters<typeof _refTool.execute>[1];
type SpawnResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('spawn_agent tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<SpawnResult> =>
    tool.execute('test', params as SpawnParams);

  it('Guide spawns conductor successfully', async () => {
    const { tool, spawner } = setup(1, [makeAgent(1, 'guide', null)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 10,
      initial_message: 'Start work',
    });

    expect((result.content[0] as { text: string }).text).toContain('Agent spawned');
    expect((result.content[0] as { text: string }).text).toContain('42');
    expect(spawner).toHaveBeenCalledWith('conductor', 10, 1, 'Start work');
  });

  it('Conductor spawns in own project', async () => {
    const { tool } = setup(2, [makeAgent(2, 'conductor', 10)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'reviewer',
      project_id: 10,
      initial_message: 'Review work',
    });

    expect((result.content[0] as { text: string }).text).toContain('Agent spawned');
  });

  it('Conductor cannot spawn in other project', async () => {
    const { tool } = setup(2, [makeAgent(2, 'conductor', 10)], [makeProject(20)]);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 20,
      initial_message: 'x',
    });

    expect((result.content[0] as { text: string }).text).toContain(
      'only spawn agents within their own project'
    );
  });

  it('Guide spawns worker successfully', async () => {
    const { tool, spawner } = setup(1, [makeAgent(1, 'guide', null)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'worker',
      project_id: 10,
      initial_message: 'Execute task #25',
    });

    expect((result.content[0] as { text: string }).text).toContain('Agent spawned');
    expect(spawner).toHaveBeenCalledWith('worker', 10, 1, 'Execute task #25');
  });

  it('Conductor spawns worker in own project', async () => {
    const { tool, spawner } = setup(2, [makeAgent(2, 'conductor', 10)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'worker',
      project_id: 10,
      initial_message: 'Execute task #26',
    });

    expect((result.content[0] as { text: string }).text).toContain('Agent spawned');
    expect(spawner).toHaveBeenCalledWith('worker', 10, 2, 'Execute task #26');
  });

  it('Worker cannot spawn', async () => {
    const { tool } = setup(4, [makeAgent(4, 'worker', 10)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'worker',
      project_id: 10,
      initial_message: 'x',
    });

    expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
  });

  it('Reviewer cannot spawn', async () => {
    const { tool } = setup(3, [makeAgent(3, 'reviewer', 10)], [makeProject(10)]);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 10,
      initial_message: 'x',
    });

    expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
  });

  it('errors when project not found', async () => {
    const { tool } = setup(1, [makeAgent(1, 'guide', null)], []);

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 999,
      initial_message: 'x',
    });

    expect((result.content[0] as { text: string }).text).toContain('not found');
  });

  it('propagates spawner errors', async () => {
    const { tool, spawner } = setup(1, [makeAgent(1, 'guide', null)], [makeProject(10)]);
    spawner.mockRejectedValue(new Error('spawn failed'));

    const result = await exec(tool, {
      role: 'conductor',
      project_id: 10,
      initial_message: 'x',
    });

    expect((result.content[0] as { text: string }).text).toContain('spawn failed');
  });
});
