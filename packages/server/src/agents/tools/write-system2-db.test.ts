import type { Agent, Artifact, Project, Task, TaskComment, TaskLink } from '@dscarabelli/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../db/client.js';
import { createWriteSystem2DbTool } from './write-system2-db.js';

// Minimal mock DatabaseClient with controllable return values
function createMockDb() {
  const agents = new Map<number, Agent>();
  const projects = new Map<number, Project>();
  const tasks = new Map<number, Task>();
  const taskLinks = new Map<number, TaskLink>();
  const taskComments = new Map<number, TaskComment>();
  let nextId = 100;

  const artifacts = new Map<number, Artifact>();

  return {
    _agents: agents,
    _projects: projects,
    _tasks: tasks,
    _taskLinks: taskLinks,
    _taskComments: taskComments,
    _artifacts: artifacts,

    getAgent: (id: number) => agents.get(id) ?? null,
    getProject: (id: number) => projects.get(id) ?? null,
    getTask: (id: number) => tasks.get(id) ?? null,
    getTaskLink: (id: number) => taskLinks.get(id) ?? null,
    getTaskComment: (id: number) => taskComments.get(id) ?? null,
    getArtifact: (id: number) => artifacts.get(id) ?? null,

    createProject: (p: Partial<Project>) => {
      const id = nextId++;
      const project = { id, ...p, created_at: 'now', updated_at: 'now' } as Project;
      projects.set(id, project);
      return project;
    },
    updateProject: (id: number, fields: Partial<Project>) => {
      const p = projects.get(id);
      if (!p) return null;
      Object.assign(p, fields);
      return p;
    },
    createTask: (t: Partial<Task>) => {
      const id = nextId++;
      const task = { id, ...t, created_at: 'now', updated_at: 'now' } as Task;
      tasks.set(id, task);
      return task;
    },
    updateTask: (id: number, fields: Partial<Task>) => {
      const t = tasks.get(id);
      if (!t) return null;
      Object.assign(t, fields);
      return t;
    },
    claimTask: (agentId: number, taskId: number) => {
      const task = tasks.get(taskId);
      if (!task) return { claimed: false, error: 'task_not_found' };
      const agent = agents.get(agentId);
      if (agent?.project !== null && task.project !== agent?.project) {
        return { claimed: false, error: 'wrong_project' };
      }
      if (task.status !== 'todo') return { claimed: false, error: 'not_available' };
      task.assignee = agentId;
      task.status = 'in progress';
      return { claimed: true, task };
    },
    createTaskLink: (l: Partial<TaskLink>) => {
      const id = nextId++;
      const link = { id, ...l, created_at: 'now', updated_at: 'now' } as TaskLink;
      taskLinks.set(id, link);
      return link;
    },
    deleteTaskLink: (id: number) => taskLinks.delete(id),
    createTaskComment: (c: Partial<TaskComment>) => {
      const id = nextId++;
      const comment = { id, ...c, created_at: 'now', updated_at: 'now' } as TaskComment;
      taskComments.set(id, comment);
      return comment;
    },
    deleteTaskComment: (id: number) => taskComments.delete(id),
    createArtifact: (a: Partial<Artifact>) => {
      const id = nextId++;
      const artifact = { id, ...a, created_at: 'now', updated_at: 'now' } as Artifact;
      artifacts.set(id, artifact);
      return artifact;
    },
    updateArtifact: (id: number, fields: Partial<Artifact>) => {
      const a = artifacts.get(id);
      if (!a) return null;
      Object.assign(a, fields);
      return a;
    },
    deleteArtifact: (id: number) => artifacts.delete(id),
    runSql: (sql: string) => {
      // Strip leading line comments (-- ...) and block comments (/* ... */) before checking keyword
      let remaining = sql;
      for (;;) {
        const t = remaining.trimStart();
        if (t.startsWith('--')) {
          const nl = t.indexOf('\n');
          remaining = nl === -1 ? '' : t.slice(nl + 1);
          continue;
        }
        if (t.startsWith('/*')) {
          const end = t.indexOf('*/');
          remaining = end === -1 ? '' : t.slice(end + 2);
          continue;
        }
        remaining = t;
        break;
      }
      if (remaining.toUpperCase().startsWith('SELECT')) {
        return { changes: 0, rows: [{ count: 42 }] };
      }
      return { changes: 1 };
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

function addAgent(db: MockDb, id: number, role: string, project: number | null) {
  db._agents.set(id, {
    id,
    role,
    project,
    status: 'active',
    created_at: 'now',
    updated_at: 'now',
  } as Agent);
}

function addTask(db: MockDb, id: number, project: number) {
  db._tasks.set(id, {
    id,
    project,
    parent: null,
    title: 'Task',
    description: 'Desc',
    status: 'todo',
    priority: 'medium',
    assignee: null,
    labels: '[]',
    start_at: null,
    end_at: null,
    created_at: 'now',
    updated_at: 'now',
  } as unknown as Task);
}

function addProject(db: MockDb, id: number) {
  db._projects.set(id, {
    id,
    name: 'Project',
    description: 'Desc',
    status: 'todo',
    labels: '[]',
    start_at: null,
    end_at: null,
    created_at: 'now',
    updated_at: 'now',
  } as unknown as Project);
}

// Derive types from the tool so tests stay in sync with implementation
const _refDb = createMockDb();
const _refTool = createWriteSystem2DbTool(_refDb as unknown as DatabaseClient, 1);
type WriteDbParams = Parameters<typeof _refTool.execute>[1];
type WriteDbResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('write_system2_db tool', () => {
  describe('createProject', () => {
    it('succeeds for Guide', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createProject',
        name: 'New Project',
        description: 'A test project',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('New Project');
    });

    it('fails for non-Guide', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 1);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createProject',
        name: 'X',
        description: 'Y',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('restricted to the Guide');
    });
  });

  describe('updateProject', () => {
    it('succeeds for Guide', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      addProject(db, 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateProject',
        id: 10,
        name: 'Updated',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Updated');
    });

    it('succeeds for Conductor on own project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addProject(db, 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateProject',
        id: 10,
        status: 'in progress',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).not.toContain('Error');
    });

    it('fails for Conductor on other project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addProject(db, 20);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateProject',
        id: 20,
        name: 'X',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain(
        'only update their own project'
      );
    });

    it('fails for Reviewer', async () => {
      const db = createMockDb();
      addAgent(db, 3, 'reviewer', 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 3);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateProject',
        id: 10,
        name: 'X',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain(
        'restricted to Guide and Conductor'
      );
    });
  });

  describe('createTask', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createTask',
        project: 20,
        title: 'Task',
        description: 'Desc',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('scoped to project 10');
    });

    it('restricts assignee to Guide/Conductor', async () => {
      const db = createMockDb();
      addAgent(db, 3, 'reviewer', 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 3);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createTask',
        project: 10,
        title: 'Task',
        description: 'Desc',
        assignee: 5,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
    });

    it('succeeds for Guide with assignee', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createTask',
        project: 10,
        title: 'Task',
        description: 'Desc',
        assignee: 2,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).not.toContain('Error');
    });
  });

  describe('updateTask', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20); // task in project 20
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateTask',
        id: 50,
        status: 'done',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('scoped to project 10');
    });

    it('restricts assignee to Guide/Conductor', async () => {
      const db = createMockDb();
      addAgent(db, 3, 'reviewer', 10);
      addTask(db, 50, 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 3);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateTask',
        id: 50,
        assignee: 5,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Only Guide and Conductor');
    });
  });

  describe('claimTask', () => {
    it('succeeds for available task in same project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'claimTask',
        id: 50,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('claimed');
    });

    it('fails for task in different project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'claimTask',
        id: 50,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('failed');
    });
  });

  describe('createTaskLink', () => {
    it('enforces project scope via source task', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20); // source in project 20
      addTask(db, 51, 20);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createTaskLink',
        source: 50,
        target: 51,
        relationship: 'blocked_by',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('scoped to project 10');
    });
  });

  describe('deleteTaskLink', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20);
      db._taskLinks.set(1, {
        id: 1,
        source: 50,
        target: 51,
        relationship: 'relates_to',
        created_at: 'now',
        updated_at: 'now',
      } as unknown as TaskLink);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'deleteTaskLink',
        id: 1,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('scoped to project 10');
    });
  });

  describe('createTaskComment', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createTaskComment',
        task: 50,
        content: 'Hello',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('scoped to project 10');
    });

    it('succeeds and auto-fills author', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 10);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createTaskComment',
        task: 50,
        content: 'A comment',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('A comment');
      // Verify author was set to agentId (2)
      const comment = [...db._taskComments.values()].pop();
      expect(comment?.author).toBe(2);
    });
  });

  describe('deleteTaskComment', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20);
      db._taskComments.set(1, {
        id: 1,
        task: 50,
        author: 2,
        content: 'x',
        created_at: 'now',
        updated_at: 'now',
      } as unknown as TaskComment);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'deleteTaskComment',
        id: 1,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('scoped to project 10');
    });
  });

  describe('createArtifact', () => {
    it('succeeds', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createArtifact',
        file_path: '/tmp/report.html',
        title: 'Report',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('report.html');
    });

    it('returns error when file_path is missing', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'createArtifact',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Error');
    });
  });

  describe('updateArtifact', () => {
    it('succeeds', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      db._artifacts.set(10, {
        id: 10,
        project: null,
        file_path: '/tmp/report.html',
        title: 'Report',
        description: null,
        tags: '[]',
        created_at: 'now',
        updated_at: 'now',
      } as unknown as Artifact);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateArtifact',
        id: 10,
        title: 'Updated Report',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Updated Report');
    });

    it('returns error when artifact not found', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'updateArtifact',
        id: 999,
        title: 'Ghost',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Error');
    });
  });

  describe('deleteArtifact', () => {
    it('succeeds', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      db._artifacts.set(10, {
        id: 10,
        project: null,
        file_path: '/tmp/report.html',
        title: 'Report',
        description: null,
        tags: '[]',
        created_at: 'now',
        updated_at: 'now',
      } as unknown as Artifact);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'deleteArtifact',
        id: 10,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('deleted');
    });

    it('returns error when artifact not found', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'deleteArtifact',
        id: 999,
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('Error');
    });
  });

  it('returns error for unknown operation', async () => {
    const db = createMockDb();
    addAgent(db, 1, 'guide', null);
    const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

    const result: WriteDbResult = await tool.execute('test', {
      operation: 'unknownOp',
    } as unknown as WriteDbParams);

    expect((result.content[0] as { text: string }).text).toContain('Unknown operation');
  });

  describe('rawSql', () => {
    it('executes a SELECT query', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'SELECT count(*) AS count FROM task',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('42');
    });

    it('executes a DML statement', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: "UPDATE task SET status = 'done' WHERE id = 1",
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('changes');
    });

    it('blocks CREATE statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'CREATE TABLE test (id INTEGER)',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks ALTER statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'ALTER TABLE task ADD COLUMN new_col TEXT',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks DROP statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'DROP TABLE task',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks PRAGMA statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'PRAGMA journal_mode=DELETE',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks ATTACH statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: "ATTACH DATABASE '/tmp/other.db' AS other",
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks DETACH statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'DETACH DATABASE other',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks DDL preceded by SQL comments', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: '-- comment\nCREATE TABLE test (id INTEGER)',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks DDL preceded by block comments', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: '/* bypass */ DROP TABLE task',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('blocks DDL');
    });

    it('blocks VACUUM statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'VACUUM',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('only allows');
    });

    it('blocks REINDEX statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'REINDEX',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('only allows');
    });

    it('blocks ANALYZE statements', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: 'ANALYZE',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('only allows');
    });

    it('allows SELECT after SQL comments', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
        sql: '-- comment\nSELECT count(*) AS count FROM task',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('42');
    });

    it('returns error when sql is missing', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1);

      const result: WriteDbResult = await tool.execute('test', {
        operation: 'rawSql',
      } as WriteDbParams);

      expect((result.content[0] as { text: string }).text).toContain('requires: sql');
    });
  });

  describe('onWrite callback', () => {
    it('fires with "project" for createProject', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'createProject',
        name: 'Test',
        description: 'Desc',
      } as WriteDbParams);

      expect(onWrite).toHaveBeenCalledWith('project');
    });

    it('fires with "task" for createTask', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'createTask',
        project: 10,
        title: 'Task',
        description: 'Desc',
      } as WriteDbParams);

      expect(onWrite).toHaveBeenCalledWith('task');
    });

    it('fires with "artifact" for createArtifact', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'createArtifact',
        file_path: '/tmp/report.html',
        title: 'Report',
      } as WriteDbParams);

      expect(onWrite).toHaveBeenCalledWith('artifact');
    });

    it('fires with "unknown" for rawSql', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'rawSql',
        sql: "UPDATE task SET status = 'done' WHERE id = 1",
      } as WriteDbParams);

      expect(onWrite).toHaveBeenCalledWith('unknown');
    });

    it('does not fire for rawSql SELECT', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'rawSql',
        sql: 'SELECT count(*) AS count FROM task',
      } as WriteDbParams);

      expect(onWrite).not.toHaveBeenCalled();
    });

    it('does not fire on error', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'rawSql',
        sql: 'CREATE TABLE nope (id INTEGER)',
      } as WriteDbParams);

      expect(onWrite).not.toHaveBeenCalled();
    });

    it('fires with "task_link" for createTaskLink', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      addTask(db, 50, 10);
      addTask(db, 51, 10);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 1, onWrite);

      await tool.execute('test', {
        operation: 'createTaskLink',
        source: 50,
        target: 51,
        relationship: 'relates_to',
      } as WriteDbParams);

      expect(onWrite).toHaveBeenCalledWith('task_link');
    });

    it('fires with "task_comment" for createTaskComment', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 10);
      const onWrite = vi.fn();
      const tool = createWriteSystem2DbTool(db as unknown as DatabaseClient, 2, onWrite);

      await tool.execute('test', {
        operation: 'createTaskComment',
        task: 50,
        content: 'Hello',
      } as WriteDbParams);

      expect(onWrite).toHaveBeenCalledWith('task_comment');
    });
  });
});
