/**
 * SQLite Database Client
 *
 * Manages System2's app.db with WAL mode for concurrent access.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Artifact, Project, Task, TaskComment, TaskLink } from '@system2/shared';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class DatabaseClient {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent reads/writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.initializeSchema();
  }

  private initializeSchema(): void {
    const schemaPath = join(__dirname, 'db', 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  // Project operations
  createProject(project: Omit<Project, 'id' | 'created_at' | 'updated_at'>): Project {
    const stmt = this.db.prepare(`
      INSERT INTO project (name, description, status, labels, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      project.name,
      project.description,
      project.status,
      JSON.stringify(project.labels),
      project.start_at,
      project.end_at
    ) as Project;
  }

  getProject(id: number): Project | null {
    const stmt = this.db.prepare('SELECT * FROM project WHERE id = ?');
    return (stmt.get(id) as Project) || null;
  }

  listProjects(status?: Project['status']): Project[] {
    if (status) {
      const stmt = this.db.prepare(
        'SELECT * FROM project WHERE status = ? ORDER BY created_at DESC'
      );
      return stmt.all(status) as Project[];
    }
    const stmt = this.db.prepare('SELECT * FROM project ORDER BY created_at DESC');
    return stmt.all() as Project[];
  }

  updateProject(
    id: number,
    updates: Partial<
      Pick<Project, 'name' | 'description' | 'status' | 'labels' | 'start_at' | 'end_at'>
    >
  ): Project | null {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.labels !== undefined) {
      fields.push('labels = ?');
      values.push(JSON.stringify(updates.labels));
    }
    if (updates.start_at !== undefined) {
      fields.push('start_at = ?');
      values.push(updates.start_at);
    }
    if (updates.end_at !== undefined) {
      fields.push('end_at = ?');
      values.push(updates.end_at);
    }

    if (fields.length === 0) return this.getProject(id);

    fields.push('updated_at = datetime("now")');
    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE project
      SET ${fields.join(', ')}
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(...values) as Project) || null;
  }

  // Task operations
  createTask(task: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Task {
    const stmt = this.db.prepare(`
      INSERT INTO task (parent, project, title, description, status, priority, assignee, labels, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      task.parent,
      task.project,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.assignee,
      JSON.stringify(task.labels),
      task.start_at,
      task.end_at
    ) as Task;
  }

  getTask(id: number): Task | null {
    const stmt = this.db.prepare('SELECT * FROM task WHERE id = ?');
    return (stmt.get(id) as Task) || null;
  }

  listTasks(project: number): Task[] {
    const stmt = this.db.prepare('SELECT * FROM task WHERE project = ? ORDER BY created_at ASC');
    return stmt.all(project) as Task[];
  }

  updateTask(
    id: number,
    updates: Partial<
      Pick<
        Task,
        | 'parent'
        | 'title'
        | 'description'
        | 'status'
        | 'priority'
        | 'assignee'
        | 'labels'
        | 'start_at'
        | 'end_at'
      >
    >
  ): Task | null {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.parent !== undefined) {
      fields.push('parent = ?');
      values.push(updates.parent);
    }
    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.assignee !== undefined) {
      fields.push('assignee = ?');
      values.push(updates.assignee);
    }
    if (updates.labels !== undefined) {
      fields.push('labels = ?');
      values.push(JSON.stringify(updates.labels));
    }
    if (updates.start_at !== undefined) {
      fields.push('start_at = ?');
      values.push(updates.start_at);
    }
    if (updates.end_at !== undefined) {
      fields.push('end_at = ?');
      values.push(updates.end_at);
    }

    if (fields.length === 0) return this.getTask(id);

    fields.push('updated_at = datetime("now")');
    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE task
      SET ${fields.join(', ')}
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(...values) as Task) || null;
  }

  /**
   * Atomically claim a task for the given agent.
   *
   * Only succeeds if the task is 'todo' AND has the same project as the agent
   * (including NULL IS NULL — project-less agents can claim project-less tasks).
   * Uses IS instead of = for the project comparison so NULL matches NULL.
   * Returns the claimed task on success, or a reason string on failure.
   */
  claimTask(
    agentId: number,
    taskId: number
  ):
    | { claimed: true; task: Task }
    | { claimed: false; error: 'task_not_found' | 'wrong_project' | 'already_claimed' } {
    const stmt = this.db.prepare(`
      UPDATE task
      SET status = 'in progress', assignee = ?, start_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
        AND status = 'todo'
        AND project IS (SELECT project FROM agent WHERE id = ?)
      RETURNING *
    `);

    const row = stmt.get(agentId, taskId, agentId) as Task | undefined;
    if (row) return { claimed: true, task: row };

    // Claim failed — diagnose why for a clear error message
    const task = this.getTask(taskId);
    if (!task) return { claimed: false, error: 'task_not_found' };

    const agent = this.getAgent(agentId);
    if (!agent || task.project !== agent.project) {
      return { claimed: false, error: 'wrong_project' };
    }

    return { claimed: false, error: 'already_claimed' };
  }

  // Agent operations
  createAgent(agent: Omit<Agent, 'id' | 'created_at' | 'updated_at'>): Agent {
    const stmt = this.db.prepare(`
      INSERT INTO agent (role, project, status)
      VALUES (?, ?, ?)
      RETURNING *
    `);

    return stmt.get(agent.role, agent.project, agent.status) as Agent;
  }

  getAgent(id: number): Agent | null {
    const stmt = this.db.prepare('SELECT * FROM agent WHERE id = ?');
    return (stmt.get(id) as Agent) || null;
  }

  listAgents(project?: number): Agent[] {
    if (project) {
      const stmt = this.db.prepare('SELECT * FROM agent WHERE project = ?');
      return stmt.all(project) as Agent[];
    }
    const stmt = this.db.prepare('SELECT * FROM agent ORDER BY created_at DESC');
    return stmt.all() as Agent[];
  }

  updateAgentStatus(id: number, status: Agent['status']): Agent | null {
    const stmt = this.db.prepare(`
      UPDATE agent
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(status, id) as Agent) || null;
  }

  /**
   * Get the Guide agent, creating it if it doesn't exist.
   * Guide is a singleton - there's only one, with project = NULL.
   */
  getOrCreateGuideAgent(): Agent {
    const findStmt = this.db.prepare('SELECT * FROM agent WHERE role = ? AND project IS NULL');
    const existing = findStmt.get('guide') as Agent | undefined;

    if (existing) {
      return existing;
    }

    return this.createAgent({
      role: 'guide',
      project: null,
      status: 'active',
    });
  }

  /**
   * Get the Narrator agent, creating it if it doesn't exist.
   * Narrator is a singleton - there's only one, with project = NULL.
   */
  getOrCreateNarratorAgent(): Agent {
    const findStmt = this.db.prepare('SELECT * FROM agent WHERE role = ? AND project IS NULL');
    const existing = findStmt.get('narrator') as Agent | undefined;

    if (existing) {
      return existing;
    }

    return this.createAgent({
      role: 'narrator',
      project: null,
      status: 'active',
    });
  }

  // Task link operations
  createTaskLink(link: Omit<TaskLink, 'id' | 'created_at' | 'updated_at'>): TaskLink {
    const stmt = this.db.prepare(`
      INSERT INTO task_link (source, target, relationship)
      VALUES (?, ?, ?)
      RETURNING *
    `);

    return stmt.get(link.source, link.target, link.relationship) as TaskLink;
  }

  getTaskLink(id: number): TaskLink | null {
    const stmt = this.db.prepare('SELECT * FROM task_link WHERE id = ?');
    return (stmt.get(id) as TaskLink) || null;
  }

  listTaskLinks(taskId: number): TaskLink[] {
    const stmt = this.db.prepare(
      'SELECT * FROM task_link WHERE source = ? OR target = ? ORDER BY created_at ASC'
    );
    return stmt.all(taskId, taskId) as TaskLink[];
  }

  deleteTaskLink(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM task_link WHERE id = ?');
    return stmt.run(id).changes > 0;
  }

  // Task comment operations
  createTaskComment(comment: Omit<TaskComment, 'id' | 'created_at' | 'updated_at'>): TaskComment {
    const stmt = this.db.prepare(`
      INSERT INTO task_comment (task, author, content)
      VALUES (?, ?, ?)
      RETURNING *
    `);

    return stmt.get(comment.task, comment.author, comment.content) as TaskComment;
  }

  getTaskComment(id: number): TaskComment | null {
    const stmt = this.db.prepare('SELECT * FROM task_comment WHERE id = ?');
    return (stmt.get(id) as TaskComment) || null;
  }

  listTaskComments(task: number): TaskComment[] {
    const stmt = this.db.prepare(
      'SELECT * FROM task_comment WHERE task = ? ORDER BY created_at ASC'
    );
    return stmt.all(task) as TaskComment[];
  }

  deleteTaskComment(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM task_comment WHERE id = ?');
    return stmt.run(id).changes > 0;
  }

  // Artifact operations
  createArtifact(artifact: Omit<Artifact, 'id' | 'created_at' | 'updated_at'>): Artifact {
    const stmt = this.db.prepare(`
      INSERT INTO artifact (project, file_path, title, description, tags)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      artifact.project,
      artifact.file_path,
      artifact.title,
      artifact.description,
      JSON.stringify(artifact.tags)
    ) as Artifact;
  }

  getArtifact(id: number): Artifact | null {
    const stmt = this.db.prepare('SELECT * FROM artifact WHERE id = ?');
    return (stmt.get(id) as Artifact) || null;
  }

  getArtifactByPath(filePath: string): Artifact | null {
    const stmt = this.db.prepare('SELECT * FROM artifact WHERE file_path = ?');
    return (stmt.get(filePath) as Artifact) || null;
  }

  updateArtifact(
    id: number,
    updates: Partial<Pick<Artifact, 'project' | 'file_path' | 'title' | 'description' | 'tags'>>
  ): Artifact | null {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.project !== undefined) {
      fields.push('project = ?');
      values.push(updates.project);
    }
    if (updates.file_path !== undefined) {
      fields.push('file_path = ?');
      values.push(updates.file_path);
    }
    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }

    if (fields.length === 0) {
      const stmt = this.db.prepare('SELECT * FROM artifact WHERE id = ?');
      return (stmt.get(id) as Artifact) || null;
    }

    fields.push('updated_at = datetime("now")');
    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE artifact
      SET ${fields.join(', ')}
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(...values) as Artifact) || null;
  }

  deleteArtifact(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM artifact WHERE id = ?');
    return stmt.run(id).changes > 0;
  }

  // Query method for custom queries (used by read_system2_db tool and REST endpoints)
  query(sql: string, params: (string | number | null)[] = []): unknown[] {
    try {
      const stmt = this.db.prepare(sql);
      return stmt.all(...params);
    } catch (error) {
      throw new Error(`Database query failed: ${(error as Error).message}`);
    }
  }

  close(): void {
    this.db.close();
  }
}
