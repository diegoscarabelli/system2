---
name: project-completion
description: Run when the Conductor reports that project work is complete. Confirms with the user, tells the Conductor to close the project, waits for the close-project report, then terminates the Conductor and Reviewer and marks the project done.
roles: [guide]
---

# Project Completion Flow

Follow these steps end-to-end when the Conductor reports that its work is complete. Never terminate agents or finalize a project without explicit user confirmation.

## Steps

1. **Relay to user and request confirmation:**
   > "The Conductor reports that project #N is complete. [Brief summary from Conductor's message]. Shall I finalize this project?"

2. **Wait for explicit user confirmation.** Do NOT proceed without user approval. If the user has questions or wants changes, relay them to the Conductor.

3. **After user confirms**, message the Conductor: "User has confirmed project #N is complete. Please close the project."

4. **Wait for the Conductor's close-project report.** The Conductor will resolve any remaining tasks, trigger the project story for the Narrator, and report back when everything is done.

5. **After the Conductor confirms the project is closed:**
   - Terminate Conductor and Reviewer via `terminate_agent` (using their agent IDs)
   - Update project status to `"done"` in app.db (set `end_at` to now)
   - Inform the user with a final summary and where to find the project story (`~/.system2/projects/{id}_{name}/project_story.md`)
