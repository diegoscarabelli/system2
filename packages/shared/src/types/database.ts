/**
 * Database Entity Types
 *
 * TypeScript interfaces for System2's SQLite app database entities.
 */

export interface Project {
  id: string; // UUID v4
  name: string;
  description: string | null;
  status: 'active' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string; // UUID v4
  project_id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assigned_agent_id: string | null;
  artifact_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string; // UUID v4
  type: 'guide' | 'conductor' | 'narrator' | 'data';
  project_id: string | null; // NULL for Guide, set for project-specific agents
  session_path: string; // Path to Pi SDK JSONL session
  status: 'idle' | 'working' | 'waiting';
  created_at: string;
  updated_at: string;
}
