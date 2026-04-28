import { existsSync } from 'node:fs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import type { Agent, Project, Task } from '../../../shared/index.js';
import type { DatabaseClient } from '../../db/client.js';
import type { AgentRegistry } from '../registry.js';
import { createTriggerProjectStoryTool } from './trigger-project-story.js';

// Mock scheduler/jobs helpers so the tool doesn't touch the filesystem
vi.mock('../../scheduler/jobs.js', () => ({
  collectAgentActivity: vi.fn().mockReturnValue('(agent activity)'),
  collectProjectDbChanges: vi.fn().mockReturnValue([
    {
      name: 'task',
      sql: 'SELECT * FROM task WHERE ...',
      timeColumn: 'updated_at',
      rows: [{ id: 1, title: 'A task', updated_at: '2026-01-01T00:00:00Z' }],
    },
  ]),
  formatMarkdownTable: vi
    .fn()
    .mockReturnValue(
      '| id | title | updated_at |\n|---|---|---|\n| 1 | A task | 2026-01-01T00:00:00Z |'
    ),
  readFrontmatterField: vi.fn().mockReturnValue(null),
  readTailChars: vi.fn().mockReturnValue('(log tail)'),
}));

// Mock node:fs so no real files are read
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

function makeAgent(id: number, role: string, project: number | null): Agent {
  return { id, role, project, status: 'active', created_at: 'now', updated_at: 'now' } as Agent;
}

function makeProject(id: number, name: string): Project {
  return {
    id,
    name,
    description: 'test project',
    dir_name: `${id}_${name}`,
    status: 'in progress',
    labels: [],
    start_at: 'now',
    end_at: null,
    created_at: 'now',
    updated_at: 'now',
  } as Project;
}

function setup(
  callerId: number,
  agents: Agent[],
  projects: Project[],
  narratorIds: number[] = [],
  registeredNarratorIds: number[] = narratorIds
) {
  const deliverMessage = vi.fn().mockReturnValue(Promise.resolve());
  const createTask = vi.fn().mockReturnValue({ id: 100 } as Task);

  const db = {
    getAgent: (id: number) => agents.find((a) => a.id === id) ?? null,
    getProject: (id: number) => projects.find((p) => p.id === id) ?? null,
    query: (sql: string) => {
      if (sql.includes("role = 'narrator'")) {
        return narratorIds.map((id) => ({ id }));
      }
      // For snapshot queries (project, agents, tasks, task_link, task_comment)
      if (sql.includes('SELECT *')) return [];
      // For allAgents query
      if (sql.includes('SELECT a.id')) {
        return agents.map((a) => ({
          id: a.id,
          role: a.role,
          project_name: projects.find((p) => p.id === a.project)?.name ?? null,
        }));
      }
      return [];
    },
    createTask,
  } as unknown as DatabaseClient;

  const registry = {
    get: (id: number) => (registeredNarratorIds.includes(id) ? { deliverMessage } : undefined),
  } as unknown as AgentRegistry;

  const tool = createTriggerProjectStoryTool(db, callerId, registry);
  return { tool, deliverMessage, createTask, db };
}

// Derive types from the tool so tests stay in sync with implementation
const { tool: _refTool } = setup(1, [], []);
type TriggerParams = Parameters<typeof _refTool.execute>[1];
type TriggerResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('trigger_project_story tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<TriggerResult> =>
    tool.execute('test', params as TriggerParams);

  it('errors when caller agent not found', async () => {
    const { tool } = setup(99, [], []);

    const result = await exec(tool, { project_id: 1 });

    expect((result.content[0] as { text: string }).text).toContain('Calling agent not found');
    expect((result.details as { error: string }).error).toBe('caller_not_found');
  });

  it('errors when project not found', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const { tool } = setup(2, [conductor], []);

    const result = await exec(tool, { project_id: 999 });

    expect((result.content[0] as { text: string }).text).toContain('Project 999 not found');
    expect((result.details as { error: string }).error).toBe('project_not_found');
  });

  it('errors when conductor triggers for a different project', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const project = makeProject(5, 'other-project');
    const { tool } = setup(2, [conductor], [project]);

    const result = await exec(tool, { project_id: 5 });

    expect((result.content[0] as { text: string }).text).toContain('your own project');
    expect((result.details as { error: string }).error).toBe('wrong_project');
  });

  it('errors when no active narrator found', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const project = makeProject(1, 'test-project');
    const { tool } = setup(2, [conductor], [project], []);

    const result = await exec(tool, { project_id: 1 });

    expect((result.content[0] as { text: string }).text).toContain('No active Narrator');
    expect((result.details as { error: string }).error).toBe('narrator_not_found');
  });

  it('errors when narrator is not registered in the agent registry', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const project = makeProject(1, 'test-project');
    // narratorIds=[10] but registeredNarratorIds=[] (narrator exists in DB but not running)
    const { tool } = setup(2, [conductor], [project], [10], []);

    const result = await exec(tool, { project_id: 1 });

    expect((result.content[0] as { text: string }).text).toContain('not registered');
    expect((result.details as { error: string }).error).toBe('narrator_not_registered');
  });

  it('succeeds for conductor on own project', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const narrator = makeAgent(10, 'narrator', null);
    const project = makeProject(1, 'test-project');
    const { tool } = setup(2, [conductor, narrator], [project], [10]);

    const result = await exec(tool, { project_id: 1 });

    expect((result.content[0] as { text: string }).text).toContain('Project story triggered');
    expect((result.content[0] as { text: string }).text).toContain('Story task ID: 100');
    expect((result.details as { task_id: number }).task_id).toBe(100);
    expect((result.details as { narrator_id: number }).narrator_id).toBe(10);
  });

  it('creates story task with correct fields', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const narrator = makeAgent(10, 'narrator', null);
    const project = makeProject(1, 'test-project');
    const { tool, createTask } = setup(2, [conductor, narrator], [project], [10]);

    await exec(tool, { project_id: 1 });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 1,
        title: 'Write project story',
        status: 'todo',
        assignee: 10,
        priority: 'medium',
        labels: ['narrative'],
      })
    );
  });

  it('delivers two messages to the narrator', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const narrator = makeAgent(10, 'narrator', null);
    const project = makeProject(1, 'test-project');
    const { tool, deliverMessage } = setup(2, [conductor, narrator], [project], [10]);

    await exec(tool, { project_id: 1 });

    expect(deliverMessage).toHaveBeenCalledTimes(2);

    // Message 1: project-log update
    const msg1 = deliverMessage.mock.calls[0][0] as string;
    expect(msg1).toContain('[Scheduled task: project-log]');
    expect(msg1).toContain('project_name: test-project');
    expect(msg1).toContain('## Most recent log.md content');
    expect(msg1).toContain('## Agent Activity');
    expect(msg1).toContain('## Database Changes');

    // Message 2: project story data
    const msg2 = deliverMessage.mock.calls[1][0] as string;
    expect(msg2).toContain('[Task: project-story]');
    expect(msg2).toContain('task_id: 100');
    expect(msg2).toContain('## Project Record');
    expect(msg2).toContain('## Project Log');
    expect(msg2).toContain('Incorporate what you just wrote');
  });

  it('includes sender and receiver metadata in delivered messages', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const narrator = makeAgent(10, 'narrator', null);
    const project = makeProject(1, 'test-project');
    const { tool, deliverMessage } = setup(2, [conductor, narrator], [project], [10]);

    await exec(tool, { project_id: 1 });

    for (const call of deliverMessage.mock.calls) {
      const meta = call[1] as { sender: number; receiver: number; timestamp: number };
      expect(meta.sender).toBe(2);
      expect(meta.receiver).toBe(10);
      expect(typeof meta.timestamp).toBe('number');
    }
  });

  it('allows guide to trigger for any project', async () => {
    const guide = makeAgent(1, 'guide', null);
    const narrator = makeAgent(10, 'narrator', null);
    const project = makeProject(5, 'any-project');
    const { tool } = setup(1, [guide, narrator], [project], [10]);

    const result = await exec(tool, { project_id: 5 });

    // Guide is not a conductor, so the "own project" check doesn't apply
    expect((result.content[0] as { text: string }).text).toContain('Project story triggered');
  });

  it('regression: DB-changes section contains markdown tables, NOT [object Object]', async () => {
    const conductor = makeAgent(2, 'conductor', 1);
    const narrator = makeAgent(10, 'narrator', null);
    const project = makeProject(1, 'test-project');
    const { tool, deliverMessage } = setup(2, [conductor, narrator], [project], [10]);

    await exec(tool, { project_id: 1 });

    const msg1 = deliverMessage.mock.calls[0][0] as string;
    // Must contain the markdown table pipe character (from formatMarkdownTable mock)
    expect(msg1).toContain('|');
    // Must contain the table name as a section header
    expect(msg1).toContain('### task');
    // Must NOT contain the string interpolation artifact
    expect(msg1).not.toContain('[object Object]');
  });

  it('includes existing story note when project_story.md exists', async () => {
    (existsSync as Mock).mockImplementation(
      (p: string) =>
        typeof p === 'string' && p.replace(/\\/g, '/').endsWith('artifacts/project_story.md')
    );
    try {
      const conductor = makeAgent(2, 'conductor', 1);
      const narrator = makeAgent(10, 'narrator', null);
      const project = makeProject(1, 'test-project');
      const { tool, deliverMessage } = setup(2, [conductor, narrator], [project], [10]);

      await exec(tool, { project_id: 1 });

      const msg2 = deliverMessage.mock.calls[1][0] as string;
      expect(msg2).toContain('Existing Project Story');
      expect(msg2).toContain('project_story.md');
      expect(msg2).toContain('Read it and decide whether to edit or rewrite');
    } finally {
      (existsSync as Mock).mockReturnValue(false);
    }
  });
});
