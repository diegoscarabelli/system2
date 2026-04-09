---
name: project-creation
description: Run when delegating complex work to a new project. Gathers preliminary requirements with the user, creates the project in app.db, spawns a Conductor and Reviewer, introduces them to each other, updates the user, and schedules a follow-up reminder so a silent Conductor is noticed.
roles: [guide]
---

# Project Creation Flow

Follow these steps end-to-end whenever you decide that a user request needs its own project (see the Role Boundary section in your base prompt for what counts as "complex"). Do not skip or reorder.

## Steps

1. **Preliminary requirements** with the user:
   This is a first pass at requirements definition. Expect them to evolve as the Conductor discovers data sources and their actual content. Cover the following topics conversationally:
   - **Objective**: what question to answer, what problem to solve, what outputs to produce
   - **Data sources**: what exists, where it lives, access methods, known quality issues
   - **Deliverables**: the forms of the outputs (report, dashboard, pipeline, dataset, model)
   - **Cadence**: one-time or recurring; if recurring, schedule and trigger conditions
   - **Analysis criteria**: any hypotheses, thresholds, metrics, or success criteria the user wants to pre-register before looking at the data
   - **Constraints**: technology preferences (default: what's already in infrastructure.md), deadlines, data sensitivity, access restrictions

2. **Create project in app.db:**
   The project `description` must capture everything gathered in step 1: objective, data sources, deliverables, cadence, analysis criteria, and constraints. This is the Conductor's primary briefing document.

   ```text
   write_system2_db: createProject
     name, description, status: "in progress", labels, start_at
   ```

3. **Spawn Conductor** via `spawn_agent`:
   - role: `"conductor"`, project_id: `<new project id>`
   - initial_message: project ID, goal, scope, data sources, constraints, and any user preferences relevant to this project. Do NOT repeat infrastructure details already in infrastructure.md; the Conductor has it in its system prompt. Remind the Conductor to consult infrastructure.md for technology decisions.

4. **Spawn Reviewer** via `spawn_agent`:
   - role: `"reviewer"`, project_id: `<new project id>`
   - initial_message: project ID, your role is to review the Conductor's analytical work for correctness and statistical rigor

5. **Message Conductor** with the Reviewer's agent ID so it can coordinate reviews.

6. **Update user**: "Project #N created. The Conductor will research the domain and discuss the implementation approach before presenting a plan for your approval."

7. **Schedule a follow-up check** via `set_reminder`:
   - `delay_minutes: 3`
   - `message`: instructions to your future self naming the Conductor's agent ID and the project ID, e.g. "Check whether conductor_N has acknowledged the initial briefing for project #M. If no message has arrived, query the agent's context and nudge it; if it is still working, re-schedule another 3-minute reminder. Keep re-scheduling until the Conductor engages."
   - Rationale: a Conductor that silently stalls is worse than one that errors out loudly. This reminder guarantees the thread stays alive.
