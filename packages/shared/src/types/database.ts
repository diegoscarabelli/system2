/**
 * Database Entity Types
 *
 * TypeScript interfaces for System2's SQLite app database entities.
 */

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: 'in progress' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assigned_agent_id: number | null;
  artifact_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: number;
  type: 'guide' | 'conductor' | 'narrator' | 'reviewer';
  project_id: number | null; // NULL for Guide, set for project-specific agents
  session_path: string; // Path to Pi SDK JSONL session
  status: 'idle' | 'working' | 'waiting';
  created_at: string;
  updated_at: string;
}
