---
name: project-completion-audit
description: Run before declaring project work complete. A self-audit checklist to honestly assess whether the deliverables actually meet the requirements before requesting final review or reporting completion to the Guide.
roles: [conductor]
---

# Project Completion Self-Audit

Apply this audit before forming the belief that project work is complete. It does not enumerate the project's requirements: those live in the project description and the acceptance criteria you wrote into each task. It enumerates the epistemic questions you must be able to answer truthfully before claiming done. The known failure mode this guards against is declaring completion based on impression — "the pipeline ran and exited successfully" — without checking whether the deliverable actually exists.

## How to use

Treat each section as a question you must answer concretely, with evidence. If you cannot answer truthfully, the project is not complete: identify the gap, address it, then re-run the audit. Do not skip questions because they feel obvious; the bar is honesty under your own gaze.

If any answer turns up "I'm not sure" or "I'd need to check": go check. The audit fails until the check is done.

## Audit

### 1. Are the deliverables real?

- For every task in the original plan, locate the concrete deliverable: a file in a repository, rows in a database table, an artifact registered in app.db, a deployed flow visible in the orchestrator. Pointing at a script that "could produce" the deliverable is not enough; the deliverable itself must exist.
- Search the relevant code for `TODO`, `FIXME`, `pass`, `mock`, `stub`, `placeholder`, hardcoded sample sizes, or short-circuit returns. Any of these in a "done" deliverable is a red flag — at least one was probably left as scaffolding and never replaced.
- For pipelines: the main flow/DAG must actually call all the extractors, transformers, and loaders the design called for. A flow that only invokes a subset is incomplete even if it returns `Completed`.

### 2. Do the deliverables verify against the acceptance criteria?

- Re-read the `description` field of each task in app.db. The acceptance criteria you wrote there are the bar. For each one, check it against the actual artifact or system state.
- For data pipelines specifically: count the rows in the target table. If the count is zero, or far below what the design implied, the pipeline is not complete regardless of what the flow run state says.
- For analytical artifacts: open the registered artifact and confirm it renders, queries the right database, and reflects the data the user asked about.

### 3. Is the kanban honest?

- Query app.db for all tasks on this project. Are any `pending` or `in_progress` that you forgot about? Those are open work, not complete work.
- For each task marked `done`, do you have direct evidence the deliverable exists and verifies (sections 1 and 2)? `done` set in app.db means the work was actually done, not that you stopped working on it.
- For each task marked `abandoned`, is there a comment explaining why? An undocumented abandonment is a hidden gap.

### 4. Did you witness the system in its end state, or are you inferring?

- "The pipeline reported `Completed`" is not evidence that data was loaded. Connect to the target database and confirm row counts, schema correctness, and a sample of values that look right.
- "The deployment was created" is not evidence that the flow runs successfully. Trigger a fresh run and watch it through, or check the most recent run's actual output (rows loaded, tables touched, log content), not just its terminal state.
- If you cannot easily inspect the end state, that is itself a problem worth surfacing — the deliverable is not observable, which means future you (or the user) cannot verify it later either.

### 5. Are environment and configuration correct for the declared scope?

- Re-read the project description: what environment / scope was the project supposed to target? (Smoke tests against `_dev`, production deployment against `_prod`, ad hoc analysis only, etc.)
- Confirm the actually-deployed configuration (`.env`, deployment parameters, target database names) matches that scope. A pipeline pointed at the wrong database or running on a default schedule it shouldn't have is incomplete work even if the code is right.

### 6. Is the documentation in place?

- For each pipeline or schema deliverable, is there a README in the pipeline directory describing data sources, schema, processing logic, and the upsert strategy? If the project plan called for documentation, missing docs means incomplete.
- Are the major decisions and findings captured in task comments, so the Narrator's project story will be grounded in real history and not silence?

## Outcome

- **Audit clean (every question answered with concrete evidence):** proceed to step 6 of `conductor.md` (request final project review from the Reviewer).
- **Audit found gaps:** address each gap as task work (resume work on the open task, or create a new task for the gap), then re-run the audit. Do not request final review with known unaddressed gaps; the Reviewer is for catching what the audit missed, not for finding what you already knew was wrong.

## Why this exists

Without an explicit self-audit, "I believe the work is complete" tends to mean "I sent the messages and reported success." The Reviewer can only catch a fraction of completion failures, and catching them at the end of the project is expensive — work has already been claimed, the Guide has already heard "it's done," and the user has already started thinking about closure. A two-minute self-audit before declaring belief is much cheaper than a re-opening cycle.
