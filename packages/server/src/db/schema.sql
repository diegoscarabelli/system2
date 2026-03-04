-- System2 App Database Schema
-- SQLite with WAL mode for concurrent access

CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'in progress' CHECK(status IN ('in progress', 'completed', 'archived')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES project(id),
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
  assigned_agent_id INTEGER,
  artifact_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('guide', 'conductor', 'narrator', 'reviewer')),
  project_id INTEGER,              -- NULL for Guide, set for project-specific agents
  session_path TEXT NOT NULL,       -- Path to Pi SDK JSONL session
  status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'waiting')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
CREATE INDEX IF NOT EXISTS idx_agent_project ON agent(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_type ON agent(type);
