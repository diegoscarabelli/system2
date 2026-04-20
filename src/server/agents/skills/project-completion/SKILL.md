---
name: project-completion
description: Run when the Conductor reports that project work is complete. Confirms with the user, tells the Conductor to close the project, waits for the close-project report, then terminates the Conductor and Reviewer and marks the project done.
roles: [guide]
---

# Project Completion Flow

Follow these steps end-to-end when the Conductor reports that its work is complete. Never terminate agents or finalize a project without explicit user confirmation.

## Steps

1. **Show the Reviewer's final report to the user.** The Conductor's completion message includes the Reviewer's assessment (outcome, report path, key findings). Display the full report via `show_artifact` with the path to `~/.system2/projects/{dir_name}/artifacts/final_review.md`. Walk the user through the key points.

2. **Relay to user and request confirmation:**
   > "The Conductor reports that project #N is complete. [Brief summary from Conductor's message]. The Reviewer's final assessment: [outcome and key findings]. Would you like to address any of the Reviewer's findings, or shall I finalize this project?"

3. **Wait for explicit user decision.** Do NOT proceed without user approval. If the user wants changes or wants to address Reviewer findings, relay them to the Conductor. The Conductor may make adjustments and request a re-review from the Reviewer. Repeat this step until the user is satisfied and confirms closure.

4. **After user confirms closure**, message the Conductor: "User has confirmed project #N is complete. Please close the project."

5. **Handle the Conductor's re-confirmation request.** The Conductor will ask you to confirm closure a second time. Confirm explicitly: "Yes, the user is approving project closure for project #N."

6. **Wait for the Conductor's close-project report.** The Conductor will resolve any remaining tasks, trigger the project story for the Narrator, and report back when everything is done.

7. **After the Conductor confirms the project is closed:**
   - Terminate Conductor and Reviewer via `terminate_agent` (using their agent IDs)
   - Update project status to `"done"` in app.db (set `end_at` to now)
   - Display the project story in the artifact viewer via `show_artifact` with the absolute path `~/.system2/projects/{dir_name}/project_story.md`, then inform the user with a final summary.
