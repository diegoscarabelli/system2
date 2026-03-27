-- System2 App Database Schema
-- SQLite with WAL mode for concurrent access

-- A data project managed by System2 agents
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY,                -- Auto-incrementing unique identifier
  name TEXT NOT NULL,                     -- Project name
  description TEXT NOT NULL,              -- Project description
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in progress', 'review', 'done', 'abandoned')), -- Current progress state
  labels TEXT NOT NULL DEFAULT '[]',      -- JSON array of string labels for categorization
  start_at TEXT,                          -- ISO 8601 timestamp when work began
  end_at TEXT,                            -- ISO 8601 timestamp when work completed
  created_at TEXT DEFAULT (datetime('now')), -- Row creation timestamp
  updated_at TEXT DEFAULT (datetime('now'))  -- Last modification timestamp
);

CREATE INDEX IF NOT EXISTS idx_project_status ON project(status);

-- An AI agent that performs work within System2, assigned to projects or system-wide
CREATE TABLE IF NOT EXISTS agent (
  id INTEGER PRIMARY KEY,                -- Auto-incrementing unique identifier
  role TEXT NOT NULL CHECK(role IN ('guide', 'conductor', 'narrator', 'reviewer')), -- Agent specialization (guide is system-wide)
  project INTEGER REFERENCES project(id), -- Assigned project, NULL for guide and narrator (system-wide)
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived')), -- Current lifecycle state
  created_at TEXT DEFAULT (datetime('now')), -- Row creation timestamp
  updated_at TEXT DEFAULT (datetime('now'))  -- Last modification timestamp
);

CREATE INDEX IF NOT EXISTS idx_agent_project ON agent(project);
CREATE INDEX IF NOT EXISTS idx_agent_role ON agent(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_guide_singleton ON agent(role) WHERE role = 'guide'; -- Only one guide agent allowed
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_narrator_singleton ON agent(role) WHERE role = 'narrator'; -- Only one narrator agent allowed

-- A unit of work within a project or standalone
CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY,                -- Auto-incrementing unique identifier
  parent INTEGER REFERENCES task(id),    -- Parent task for subtask hierarchy, NULL for top-level tasks
  project INTEGER REFERENCES project(id), -- Parent project, NULL for standalone tasks
  title TEXT NOT NULL,                    -- Short task title
  description TEXT NOT NULL,              -- Detailed task description
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in progress', 'review', 'done', 'abandoned')), -- Current progress state
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')), -- Task urgency level
  assignee INTEGER REFERENCES agent(id), -- Agent responsible for this task, NULL if unassigned
  labels TEXT NOT NULL DEFAULT '[]',      -- JSON array of string labels for categorization
  start_at TEXT,                          -- ISO 8601 timestamp when work began
  end_at TEXT,                            -- ISO 8601 timestamp when work completed
  created_at TEXT DEFAULT (datetime('now')), -- Row creation timestamp
  updated_at TEXT DEFAULT (datetime('now'))  -- Last modification timestamp
);

CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent);
CREATE INDEX IF NOT EXISTS idx_task_project ON task(project);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
CREATE INDEX IF NOT EXISTS idx_task_assignee ON task(assignee);

-- Directed link between two tasks (blocked_by, relates_to, duplicates)
CREATE TABLE IF NOT EXISTS task_link (
  id INTEGER PRIMARY KEY,                       -- Auto-incrementing unique identifier
  source INTEGER NOT NULL REFERENCES task(id),  -- The task that has the relationship
  target INTEGER NOT NULL REFERENCES task(id),  -- The task being referenced
  relationship TEXT NOT NULL CHECK(relationship IN ('blocked_by', 'relates_to', 'duplicates')), -- Link type
  created_at TEXT DEFAULT (datetime('now')),     -- Row creation timestamp
  updated_at TEXT DEFAULT (datetime('now'))      -- Last modification timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_link_unique ON task_link(source, target, relationship);
CREATE INDEX IF NOT EXISTS idx_task_link_target ON task_link(target);

-- A comment on a task, authored by an agent
CREATE TABLE IF NOT EXISTS task_comment (
  id INTEGER PRIMARY KEY,                    -- Auto-incrementing unique identifier
  task INTEGER NOT NULL REFERENCES task(id), -- The task being commented on
  author INTEGER NOT NULL REFERENCES agent(id), -- The agent who wrote the comment
  content TEXT NOT NULL,                     -- Comment body
  created_at TEXT DEFAULT (datetime('now')), -- Row creation timestamp
  updated_at TEXT DEFAULT (datetime('now'))  -- Last modification timestamp
);

CREATE INDEX IF NOT EXISTS idx_task_comment_task ON task_comment(task);
CREATE INDEX IF NOT EXISTS idx_task_comment_author ON task_comment(author);

-- A file artifact created by agents, displayed in the UI
CREATE TABLE IF NOT EXISTS artifact (
  id INTEGER PRIMARY KEY,                      -- Auto-incrementing unique identifier
  project INTEGER REFERENCES project(id),      -- Associated project, NULL for project-free artifacts
  file_path TEXT NOT NULL UNIQUE,              -- Absolute path to the file on disk
  title TEXT NOT NULL,                         -- Human-readable title
  description TEXT,                            -- Brief summary of content/purpose
  tags TEXT NOT NULL DEFAULT '[]',             -- JSON array of string tags for categorization
  created_at TEXT DEFAULT (datetime('now')),   -- Row creation timestamp
  updated_at TEXT DEFAULT (datetime('now'))    -- Last modification timestamp
);

CREATE INDEX IF NOT EXISTS idx_artifact_project ON artifact(project);
CREATE INDEX IF NOT EXISTS idx_artifact_file_path ON artifact(file_path);

-- A record of a scheduler job execution
CREATE TABLE IF NOT EXISTS job_execution (
  id           INTEGER PRIMARY KEY,                -- Auto-incrementing unique identifier
  job_name     TEXT NOT NULL,                       -- Job identifier (e.g., 'daily-summary', 'memory-update')
  status       TEXT NOT NULL DEFAULT 'running'      -- Execution lifecycle state
               CHECK(status IN ('running', 'completed', 'failed')),
  trigger_type TEXT NOT NULL                        -- How the execution was initiated
               CHECK(trigger_type IN ('cron', 'catch-up', 'manual')),
  error        TEXT,                                -- Error message if status is 'failed'
  started_at   TEXT NOT NULL DEFAULT (datetime('now')), -- When the execution began
  ended_at     TEXT,                                -- When the execution finished (NULL while running)
  created_at   TEXT DEFAULT (datetime('now')),       -- Row creation timestamp
  updated_at   TEXT DEFAULT (datetime('now'))        -- Last modification timestamp
);

CREATE INDEX IF NOT EXISTS idx_job_execution_job_name   ON job_execution(job_name);
CREATE INDEX IF NOT EXISTS idx_job_execution_status     ON job_execution(status);
CREATE INDEX IF NOT EXISTS idx_job_execution_started_at ON job_execution(started_at);
