/**
 * Database Entity Types
 *
 * TypeScript interfaces for System2's SQLite app database entities.
 */

export interface Project {
  id: number;
  name: string;
  description: string;
  status: 'todo' | 'in progress' | 'review' | 'done' | 'abandoned';
  labels: string[];
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  parent: number | null;
  project: number | null;
  title: string;
  description: string;
  status: 'todo' | 'in progress' | 'review' | 'done' | 'abandoned';
  priority: 'low' | 'medium' | 'high';
  assignee: number | null;
  labels: string[];
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLink {
  id: number;
  source: number;
  target: number;
  relationship: 'blocked_by' | 'relates_to' | 'duplicates';
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: number;
  task: number;
  author: number;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: number;
  role: 'guide' | 'conductor' | 'narrator' | 'reviewer';
  project: number | null; // NULL for Guide and Narrator (system-wide), set for project-specific agents
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: number;
  project: number | null; // NULL for project-free artifacts
  file_path: string; // Absolute path to the file on disk
  title: string;
  description: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}
