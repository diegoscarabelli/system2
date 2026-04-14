---
name: db-schema-reference
description: Column-level schema details for all seven app.db tables. Read this when you need exact column names, types, constraints, or indexes before writing queries or creating/updating records.
roles: [guide, conductor, reviewer, worker]
---

# Database Schema Reference

Column-level details for the seven tables in `app.db`. All timestamps are UTC ISO 8601.

## project

A data project managed by System2 agents.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| name | TEXT NOT NULL | Project name |
| description | TEXT NOT NULL | Project description |
| status | TEXT NOT NULL | `todo`, `in progress`, `review`, `done`, `abandoned` (default `todo`) |
| labels | TEXT NOT NULL | JSON array of string labels (default `[]`) |
| start_at | TEXT | ISO 8601 timestamp when work began |
| end_at | TEXT | ISO 8601 timestamp when work completed |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

## agent

An AI agent that performs work within System2, assigned to a project or system-wide.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| role | TEXT NOT NULL | `guide`, `conductor`, `narrator`, `reviewer` |
| project | INTEGER FK | References `project(id)`. NULL for system-wide agents |
| status | TEXT | `active`, `archived` (default `active`) |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

Unique indexes enforce singleton constraints on `guide` and `narrator` roles.

## task

A unit of work within a project or standalone.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| parent | INTEGER FK | References `task(id)`. NULL for top-level tasks |
| project | INTEGER FK | References `project(id)`. NULL for standalone tasks |
| title | TEXT NOT NULL | Short task title |
| description | TEXT NOT NULL | Detailed description |
| status | TEXT NOT NULL | `todo`, `in progress`, `review`, `done`, `abandoned` (default `todo`) |
| priority | TEXT NOT NULL | `low`, `medium`, `high` (default `medium`) |
| assignee | INTEGER FK | References `agent(id)`. NULL if unassigned |
| labels | TEXT NOT NULL | JSON array of string labels (default `[]`) |
| start_at | TEXT | ISO 8601 timestamp when work began |
| end_at | TEXT | ISO 8601 timestamp when work completed |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

## task_link

A directed link between two tasks.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| source | INTEGER FK NOT NULL | References `task(id)`. The task that has the relationship |
| target | INTEGER FK NOT NULL | References `task(id)`. The task being referenced |
| relationship | TEXT NOT NULL | `blocked_by`, `relates_to`, `duplicates` |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

Unique index on (`source`, `target`, `relationship`).

## task_comment

A comment on a task, authored by an agent.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| task | INTEGER FK NOT NULL | References `task(id)` |
| author | INTEGER FK NOT NULL | References `agent(id)`. Auto-filled from the calling agent |
| content | TEXT NOT NULL | Comment body |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

`updateTaskComment` is restricted to the original author so attribution stays honest.

## artifact

A file artifact created by agents, displayed in the UI.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| project | INTEGER FK | References `project(id)`. NULL for project-free artifacts |
| file_path | TEXT NOT NULL UNIQUE | Absolute path to the file on disk |
| title | TEXT NOT NULL | Human-readable title |
| description | TEXT | Brief summary of content or purpose |
| tags | TEXT NOT NULL | JSON array of string tags (default `[]`) |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

## job_execution

A record of a scheduler job execution.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-incrementing |
| job_name | TEXT NOT NULL | Job identifier (`daily-summary`, `memory-update`) |
| status | TEXT NOT NULL | `running`, `completed`, `failed`, `skipped` (default `running`) |
| trigger_type | TEXT NOT NULL | `cron`, `catch-up`, `manual` |
| error | TEXT | Error message (failed) or skip reason (skipped) |
| started_at | TEXT NOT NULL | When execution began |
| ended_at | TEXT | When execution finished (NULL while running) |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |
