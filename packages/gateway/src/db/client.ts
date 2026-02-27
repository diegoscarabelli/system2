/**
 * SQLite Database Client
 *
 * Manages System2's app.db with WAL mode for concurrent access.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Project, Task, Agent } from '@system2/shared';

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
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  // Project operations
  createProject(project: Omit<Project, 'created_at' | 'updated_at'>): Project {
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, description, status)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      project.id,
      project.name,
      project.description,
      project.status
    ) as Project;
  }

  getProject(id: string): Project | null {
    const stmt = this.db.prepare('SELECT * FROM projects WHERE id = ?');
    return (stmt.get(id) as Project) || null;
  }

  listProjects(status?: Project['status']): Project[] {
    if (status) {
      const stmt = this.db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC');
      return stmt.all(status) as Project[];
    }
    const stmt = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC');
    return stmt.all() as Project[];
  }

  updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'status'>>): Project | null {
    const fields: string[] = [];
    const values: any[] = [];

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
      UPDATE projects
      SET ${fields.join(', ')}
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(...values) as Project) || null;
  }

  // Task operations
  createTask(task: Omit<Task, 'created_at' | 'updated_at'>): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, assigned_agent_id, artifact_path)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      task.id,
      task.project_id,
      task.title,
      task.status,
      task.assigned_agent_id,
      task.artifact_path
    ) as Task;
  }

  getTask(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    return (stmt.get(id) as Task) || null;
  }

  listTasks(projectId: string): Task[] {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC');
    return stmt.all(projectId) as Task[];
  }

  updateTask(id: string, updates: Partial<Pick<Task, 'status' | 'assigned_agent_id' | 'artifact_path'>>): Task | null {
    const fields: string[] = [];
    const values: any[] = [];

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
      UPDATE tasks
      SET ${fields.join(', ')}
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(...values) as Task) || null;
  }

  // Agent operations
  createAgent(agent: Omit<Agent, 'created_at' | 'updated_at'>): Agent {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, type, project_id, session_path, status)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);

    return stmt.get(
      agent.id,
      agent.type,
      agent.project_id,
      agent.session_path,
      agent.status
    ) as Agent;
  }

  getAgent(id: string): Agent | null {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE id = ?');
    return (stmt.get(id) as Agent) || null;
  }

  listAgents(projectId?: string): Agent[] {
    if (projectId) {
      const stmt = this.db.prepare('SELECT * FROM agents WHERE project_id = ?');
      return stmt.all(projectId) as Agent[];
    }
    const stmt = this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC');
    return stmt.all() as Agent[];
  }

  updateAgentStatus(id: string, status: Agent['status']): Agent | null {
    const stmt = this.db.prepare(`
      UPDATE agents
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `);

    return (stmt.get(status, id) as Agent) || null;
  }

  // Query method for custom queries (used by query_database tool)
  query(sql: string): any[] {
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
