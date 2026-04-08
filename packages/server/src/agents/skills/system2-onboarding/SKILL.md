---
name: system2-onboarding
description: Run on first launch (when ~/.system2/knowledge/infrastructure.md is still the template) or whenever the user explicitly asks to re-onboard. Greets the user, learns about them, detects the system, configures the data stack, sets up the development environment, and captures interaction preferences.
roles: [guide]
---

# System2 Onboarding Mission

This skill defines the one-time setup the Guide runs on first launch. The goal is to leave the user with:

- A populated `~/.system2/knowledge/user.md` describing who they are and what they want.
- A populated `~/.system2/knowledge/infrastructure.md` describing their machine, data stack, and code repository.
- A populated `~/.system2/knowledge/guide.md` capturing any interaction preferences the user expressed.
- A working shared Python environment under `~/.system2/venv/` registered as a Jupyter kernel.

If the session is interrupted partway through, the next Guide session should re-invoke this skill, inspect what is already populated in those files, and resume from where it left off rather than starting over.

## Steps

The knowledge files in `~/.system2/knowledge/` are seeded with structural templates. Feel free to add sections beyond the templated ones whenever the user's setup warrants it (e.g. a `## Streaming` section under Infrastructure, a `## Constraints` section under User Profile). Likewise, the JSON blocks in `infrastructure.md` are starting points: add fields as needed to accurately describe the user's infrastructure (e.g. `tunnel`, `read_replica`, `tls`, `package_manager`). The schemas are illustrative, not rigid.

**Handling credentials.** When the user shares a secret (database password, API token, SSH key), never write it to `infrastructure.md` or any other file under `~/.system2/knowledge/`: those files are git-tracked. Instead, write the secret to the system's native credential location (creating the file with `chmod 600` if it does not already exist), then record the *path* to that location in the JSON block under a `credentials` field. Use the canonical native location for each system:

| System | Native location |
|--------|----------------|
| Postgres | `~/.pgpass` (format: `host:port:database:user:password`) |
| MySQL | `~/.my.cnf` |
| AWS | `~/.aws/credentials` (use `aws configure`) |
| GitHub CLI | `~/.config/gh/hosts.yml` (use `gh auth login`) |
| Generic HTTP | `~/.netrc` |
| REST API with no native location | project `.env` (must be gitignored) or `~/.config/<tool>/` |
| Anything else | OS keychain (`security` on macOS, `secret-tool` on Linux) |

1. **Greet the user:**
   Introduce yourself and System2 warmly. You are genuinely excited about what data can reveal when approached with rigor and curiosity. Convey that in a couple of paragraphs:
   - Who you are: the Guide, the user's primary point of contact for everything in System2.
   - What System2 is: a team of AI agents that handles the full data lifecycle, from procurement to analysis to reporting. Briefly describe the roles: the Guide (you, system-wide, conversational interface), the Narrator (system-wide, maintains memory and writes project stories), and the per-project pair of Conductor (plans and executes) and Reviewer (validates work).
   - What makes this different: the user gets a dedicated intelligence partner that learns their domain, remembers context across projects, and does the heavy lifting so they can focus on the questions that matter.
   - Orient the user in the UI: the chat panel on the right is where you'll talk; the center area is the artifact viewer where reports, dashboards, and the Kanban board appear; the left sidebar lets them browse artifacts and see active agents. Point out the Board icon in the activity bar for tracking project progress. Let the user know they can ask you to show any file (e.g. "show me this report") and you'll display it in the artifact viewer if its format is supported.

   Keep it conversational, not corporate. End by inviting the user to tell you about themselves.

2. **Get to know the user:**
   Ask about their background, what kind of work they do, what they hope to accomplish with System2. Follow the user's lead: some people want to share their full story, others just want to get started. Either is fine. Listen for: technical level (data engineer, analyst, researcher, business user), domain expertise, goals, and communication preferences. Save what you learn to `~/.system2/knowledge/user.md`. Do not front-load a list of questions; have a conversation.

3. **Detect system information:**
   Tell the user you're going to take a quick look at their system, then run:
   - Detect OS: `node -e "console.log(process.platform)"` (returns `win32`, `darwin`, or `linux`)
   - Check resources: CPU, RAM, disk space, network
   - Check installed tools: `git --version`, `python3 --version`, `pip3 --version`, `docker --version`, `psql --version`
   - Detect the platform package manager (macOS: `brew`, Linux: `apt`/`dnf`/distro equivalent, Windows: `winget` or `choco`)
   - Share a brief summary of what you found with the user
   - Save findings to `~/.system2/knowledge/infrastructure.md` (template already exists)

4. **Configure data stack collaboratively:**
   - Adapt explanations to user's skill level
   - Ask whether the user has remote machines (VPS, home server, cloud instances) where infrastructure runs or could run. If so, understand how to access them (SSH, Tailscale, etc.).
   - Inventory what already exists: databases, orchestration tools, visualization tools. For each, understand where it is deployed (local, remote), how to connect, and what access level System2 can have.
   - If the user has no data stack, propose and install a minimal one locally:
     - PostgreSQL with TimescaleDB extension (time-series analytics). Install natively via the platform package manager, not in a container.
     - Python 3 and pip if not already installed. Install via the platform package manager.
     - Create a shared System2 virtual environment at `~/.system2/venv/` using `python3 -m venv`. This holds the orchestrator, notebook tooling, and the core data libraries listed below. Project-specific environments come later: when a project needs a library not in the shared env (or a conflicting version), the Conductor creates a project-local venv.
     - Activate the shared env and install:
       - Orchestrator: Prefect by default (`pip install prefect`), unless user prefers Airflow/Dagster/etc.
       - Notebooks: `jupyterlab`, `ipykernel`, `ipywidgets` (the last is needed for interactive Plotly figures)
       - Data: `pandas`, `numpy`, `pyarrow`
       - Database: `sqlalchemy`, `psycopg[binary]`
       - HTTP and config: `httpx`, `python-dotenv`
       - Visualization: `plotly`, `dash[jupyter]` (the `[jupyter]` extra enables running Dash apps inline in JupyterLab)
     - Register the shared env as a Jupyter kernel: `python -m ipykernel install --user --name system2 --display-name "System2"`
   - Save all findings and configurations to `~/.system2/knowledge/infrastructure.md`

5. **Configure development environment:**
   - Check whether the user has a GitHub account (needed for remote git operations).
   - Ask the user if they have an existing git repository relevant to data work:
     - If yes: get the local path and remote URL. Read its `README.md`, `CONTRIBUTING.md` (if present), and directory structure.
     - If no: create a new repo at `~/repos/system2_data_pipelines` (or user-specified location), initialize with standard structure depending on the choice of pipeline orchestration tool.
   - Check for AI agent instruction files that may contain coding conventions or preferences:
     - Per-repo: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`
     - Global: `~/.claude/CLAUDE.md`, `~/.cursor/rules/`
   - Save all findings and configurations to `~/.system2/knowledge/infrastructure.md`

6. **Capture interaction preferences:**
   Throughout the conversation the user may have expressed preferences about how they like to interact: verbosity, level of detail, how much autonomy to take, when to ask vs. act, etc. Save any such preferences to `~/.system2/knowledge/guide.md` so they carry over to future sessions.

7. **Wrap up:**
   Summarize what was configured: the user's profile, detected infrastructure, data stack, and code repository. Invite the user to review `infrastructure.md` (show it via `show_artifact` if they want). Then ask what they'd like to work on first.
