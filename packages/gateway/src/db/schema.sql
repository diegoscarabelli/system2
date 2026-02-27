-- System2 App Database Schema
-- SQLite with WAL mode for concurrent access

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,          -- UUID v4
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'archived')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,          -- UUID v4
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
  assigned_agent_id TEXT,
  artifact_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,          -- UUID v4
  type TEXT NOT NULL CHECK(type IN ('guide', 'conductor', 'narrator', 'data')),
  project_id TEXT,              -- NULL for Guide, set for project-specific agents
  session_path TEXT NOT NULL,   -- Path to Pi SDK JSONL session
  status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'waiting')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);
