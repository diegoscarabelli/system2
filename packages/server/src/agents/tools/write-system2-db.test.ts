import type { Agent, Project, Task, TaskComment, TaskLink } from '@system2/shared';
import { describe, expect, it } from 'vitest';
import { createWriteSystem2DbTool } from './write-system2-db.js';

// Minimal mock DatabaseClient with controllable return values
function createMockDb() {
  const agents = new Map<number, Agent>();
  const projects = new Map<number, Project>();
  const tasks = new Map<number, Task>();
  const taskLinks = new Map<number, TaskLink>();
  const taskComments = new Map<number, TaskComment>();
  let nextId = 100;

  return {
    _agents: agents,
    _projects: projects,
    _tasks: tasks,
    _taskLinks: taskLinks,
    _taskComments: taskComments,

    getAgent: (id: number) => agents.get(id) ?? null,
    getProject: (id: number) => projects.get(id) ?? null,
    getTask: (id: number) => tasks.get(id) ?? null,
    getTaskLink: (id: number) => taskLinks.get(id) ?? null,
    getTaskComment: (id: number) => taskComments.get(id) ?? null,

    createProject: (p: any) => {
      const id = nextId++;
      const project = { id, ...p, created_at: 'now', updated_at: 'now' };
      projects.set(id, project);
      return project;
    },
    updateProject: (id: number, fields: any) => {
      const p = projects.get(id);
      if (!p) return null;
      Object.assign(p, fields);
      return p;
    },
    createTask: (t: any) => {
      const id = nextId++;
      const task = { id, ...t, created_at: 'now', updated_at: 'now' };
      tasks.set(id, task);
      return task;
    },
    updateTask: (id: number, fields: any) => {
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
    createTaskLink: (l: any) => {
      const id = nextId++;
      const link = { id, ...l, created_at: 'now', updated_at: 'now' };
      taskLinks.set(id, link);
      return link;
    },
    deleteTaskLink: (id: number) => taskLinks.delete(id),
    createTaskComment: (c: any) => {
      const id = nextId++;
      const comment = { id, ...c, created_at: 'now', updated_at: 'now' };
      taskComments.set(id, comment);
      return comment;
    },
    deleteTaskComment: (id: number) => taskComments.delete(id),
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
  } as any);
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
  } as any);
}

describe('write_system2_db tool', () => {
  describe('createProject', () => {
    it('succeeds for Guide', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as any, 1);

      const result = await tool.execute('test', {
        operation: 'createProject',
        name: 'New Project',
        description: 'A test project',
      } as any);

      expect(result.content[0].text).toContain('New Project');
    });

    it('fails for non-Guide', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 1);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'createProject',
        name: 'X',
        description: 'Y',
      } as any);

      expect(result.content[0].text).toContain('restricted to the Guide');
    });
  });

  describe('updateProject', () => {
    it('succeeds for Guide', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      addProject(db, 10);
      const tool = createWriteSystem2DbTool(db as any, 1);

      const result = await tool.execute('test', {
        operation: 'updateProject',
        id: 10,
        name: 'Updated',
      } as any);

      expect(result.content[0].text).toContain('Updated');
    });

    it('succeeds for Conductor on own project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addProject(db, 10);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'updateProject',
        id: 10,
        status: 'in progress',
      } as any);

      expect(result.content[0].text).not.toContain('Error');
    });

    it('fails for Conductor on other project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addProject(db, 20);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'updateProject',
        id: 20,
        name: 'X',
      } as any);

      expect(result.content[0].text).toContain('only update their own project');
    });

    it('fails for Reviewer', async () => {
      const db = createMockDb();
      addAgent(db, 3, 'reviewer', 10);
      const tool = createWriteSystem2DbTool(db as any, 3);

      const result = await tool.execute('test', {
        operation: 'updateProject',
        id: 10,
        name: 'X',
      } as any);

      expect(result.content[0].text).toContain('restricted to Guide and Conductor');
    });
  });

  describe('createTask', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'createTask',
        project: 20,
        title: 'Task',
        description: 'Desc',
      } as any);

      expect(result.content[0].text).toContain('scoped to project 10');
    });

    it('restricts assignee to Guide/Conductor', async () => {
      const db = createMockDb();
      addAgent(db, 3, 'reviewer', 10);
      const tool = createWriteSystem2DbTool(db as any, 3);

      const result = await tool.execute('test', {
        operation: 'createTask',
        project: 10,
        title: 'Task',
        description: 'Desc',
        assignee: 5,
      } as any);

      expect(result.content[0].text).toContain('Only Guide and Conductor');
    });

    it('succeeds for Guide with assignee', async () => {
      const db = createMockDb();
      addAgent(db, 1, 'guide', null);
      const tool = createWriteSystem2DbTool(db as any, 1);

      const result = await tool.execute('test', {
        operation: 'createTask',
        project: 10,
        title: 'Task',
        description: 'Desc',
        assignee: 2,
      } as any);

      expect(result.content[0].text).not.toContain('Error');
    });
  });

  describe('updateTask', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20); // task in project 20
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'updateTask',
        id: 50,
        status: 'done',
      } as any);

      expect(result.content[0].text).toContain('scoped to project 10');
    });

    it('restricts assignee to Guide/Conductor', async () => {
      const db = createMockDb();
      addAgent(db, 3, 'reviewer', 10);
      addTask(db, 50, 10);
      const tool = createWriteSystem2DbTool(db as any, 3);

      const result = await tool.execute('test', {
        operation: 'updateTask',
        id: 50,
        assignee: 5,
      } as any);

      expect(result.content[0].text).toContain('Only Guide and Conductor');
    });
  });

  describe('claimTask', () => {
    it('succeeds for available task in same project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 10);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'claimTask',
        id: 50,
      } as any);

      expect(result.content[0].text).toContain('claimed');
    });

    it('fails for task in different project', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'claimTask',
        id: 50,
      } as any);

      expect(result.content[0].text).toContain('failed');
    });
  });

  describe('createTaskLink', () => {
    it('enforces project scope via source task', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20); // source in project 20
      addTask(db, 51, 20);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'createTaskLink',
        source: 50,
        target: 51,
        relationship: 'blocked_by',
      } as any);

      expect(result.content[0].text).toContain('scoped to project 10');
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
      } as any);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'deleteTaskLink',
        id: 1,
      } as any);

      expect(result.content[0].text).toContain('scoped to project 10');
    });
  });

  describe('createTaskComment', () => {
    it('enforces project scope', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 20);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'createTaskComment',
        task: 50,
        content: 'Hello',
      } as any);

      expect(result.content[0].text).toContain('scoped to project 10');
    });

    it('succeeds and auto-fills author', async () => {
      const db = createMockDb();
      addAgent(db, 2, 'conductor', 10);
      addTask(db, 50, 10);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'createTaskComment',
        task: 50,
        content: 'A comment',
      } as any);

      expect(result.content[0].text).toContain('A comment');
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
      } as any);
      const tool = createWriteSystem2DbTool(db as any, 2);

      const result = await tool.execute('test', {
        operation: 'deleteTaskComment',
        id: 1,
      } as any);

      expect(result.content[0].text).toContain('scoped to project 10');
    });
  });

  it('returns error for unknown operation', async () => {
    const db = createMockDb();
    addAgent(db, 1, 'guide', null);
    const tool = createWriteSystem2DbTool(db as any, 1);

    const result = await tool.execute('test', {
      operation: 'unknownOp',
    } as any);

    expect(result.content[0].text).toContain('Unknown operation');
  });
});
