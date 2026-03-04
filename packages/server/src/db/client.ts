/**
 * SQLite Database Client
 *
 * Manages System2's app.db with WAL mode for concurrent access.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Project, Task } from '@system2/shared';
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
      INSERT INTO project (name, description, status)
      VALUES (?, ?, ?)
      RETURNING *
    `);

    return stmt.get(project.name, project.description, project.status) as Project;
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
    updates: Partial<Pick<Project, 'name' | 'description' | 'status'>>
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
      INSERT INTO task (project_id, title, status, assigned_agent_id, artifact_path)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      task.project_id,
      task.title,
      task.status,
      task.assigned_agent_id,
      task.artifact_path
    ) as Task;
  }

  getTask(id: number): Task | null {
    const stmt = this.db.prepare('SELECT * FROM task WHERE id = ?');
    return (stmt.get(id) as Task) || null;
  }

  listTasks(projectId: number): Task[] {
    const stmt = this.db.prepare('SELECT * FROM task WHERE project_id = ? ORDER BY created_at ASC');
    return stmt.all(projectId) as Task[];
  }

  updateTask(
    id: number,
    updates: Partial<Pick<Task, 'status' | 'assigned_agent_id' | 'artifact_path'>>
  ): Task | null {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.assigned_agent_id !== undefined) {
      fields.push('assigned_agent_id = ?');
      values.push(updates.assigned_agent_id);
    }
    if (updates.artifact_path !== undefined) {
      fields.push('artifact_path = ?');
      values.push(updates.artifact_path);
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

  // Agent operations
  createAgent(agent: Omit<Agent, 'id' | 'created_at' | 'updated_at'>): Agent {
    const stmt = this.db.prepare(`
      INSERT INTO agent (type, project_id, session_path, status)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(agent.type, agent.project_id, agent.session_path, agent.status) as Agent;
  }

  getAgent(id: number): Agent | null {
    const stmt = this.db.prepare('SELECT * FROM agent WHERE id = ?');
    return (stmt.get(id) as Agent) || null;
  }

  listAgents(projectId?: number): Agent[] {
    if (projectId) {
      const stmt = this.db.prepare('SELECT * FROM agent WHERE project_id = ?');
      return stmt.all(projectId) as Agent[];
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
   * Guide is a singleton - there's only one, with project_id = NULL.
   */
  getOrCreateGuideAgent(): Agent {
    const findStmt = this.db.prepare('SELECT * FROM agent WHERE type = ? AND project_id IS NULL');
    const existing = findStmt.get('guide') as Agent | undefined;

    if (existing) {
      return existing;
    }

    return this.createAgent({
      type: 'guide',
      project_id: null,
      session_path: 'sessions/guide',
      status: 'idle',
    });
  }

  // Query method for custom queries (used by query_database tool)
  query(sql: string): unknown[] {
    try {
      const stmt = this.db.prepare(sql);
      return stmt.all();
    } catch (error) {
      throw new Error(`Database query failed: ${(error as Error).message}`);
    }
  }

  close(): void {
    this.db.close();
  }
}
