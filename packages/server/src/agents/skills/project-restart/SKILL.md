---
name: project-restart
description: Run when the user wants to revisit or continue work on a completed project. Helps the user weigh resurrection against a new project or a bespoke task, then resurrects the original Conductor and Reviewer with their context intact and reopens the project record.
roles: [guide]
---

# Project Restart Flow

Follow these steps end-to-end when the user wants to revisit or continue work on a completed project. Resurrection is not always the right choice: make sure the user actually wants their old agents back before touching anything.

## Steps

1. **Help the user think through alternatives.** Resurrection is not always the right choice. Consider:
   - **New project**: if the scope has changed significantly, a fresh project with new agents may be cleaner
   - **Bespoke task**: if the user just needs a quick query or explanation, handle it directly without restarting the project
   - **Resurrection**: if the user wants to continue the same line of work with the original agents' context intact

2. **Get explicit user confirmation** that resurrection is the right approach before proceeding.

3. **Query archived agents** for the project:

   ```sql
   SELECT id, role, status FROM agent WHERE project = <project_id> AND status = 'archived'
   ```

4. **Resurrect agents** via `resurrect_agent`:
   - Resurrect the Conductor first, then the Reviewer
   - The `message` parameter must orient each agent about the time gap, why it is being resurrected, and what work is now expected. Be specific about any changes since the agent was last active.

5. **Update the project record** via `write_system2_db`:
   - Clear `end_at` (set to null)
   - Set status to `"in progress"`

6. **Inform the user**: "Project #N has been restarted. The Conductor and Reviewer have been resurrected with their original context. [Brief summary of what happens next]."
