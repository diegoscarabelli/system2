# Scratchpad

The scratchpad is a working area for exploration, testing, and debugging. It holds prototype scripts, intermediate data dumps, draft notebooks, experimental queries, and any other transient files agents produce while figuring something out. Scratchpad files are working materials, not deliverables: they are not registered in the database and do not appear in the artifact catalog. `show_artifact` can technically display any file, so an agent may show a scratchpad file if the user explicitly asks to see one, but the normal flow is to promote a file to an artifact first when it becomes worth showing.

The scratchpad is the companion working area to [Artifacts](artifacts.md): exploration happens in the scratchpad, finished deliverables are promoted to artifacts.

**Key source files:**
- `packages/server/src/agents/agents.md`: agent-facing instructions on what belongs in the scratchpad and how it relates to artifacts and pipeline code

## What Goes in the Scratchpad

Examples of scratchpad files:
- Prototype Python scripts being iterated on
- Source Jupyter notebooks (`.ipynb`) under active editing
- Intermediate DataFrames snapshotted as parquet for reuse across runs
- Pickled Python objects (models, fitted estimators, dicts of arrays) used as caches
- Small JSON data caches (config-like dicts, sample API responses)
- Draft SQL queries and ad-hoc analysis snippets
- Throwaway plots produced during exploratory analysis

Not in the scratchpad:
- **Deliverables**: anything meant for the user to read or see belongs in [Artifacts](artifacts.md), with a database record.
- **Data pipeline code**: ingestion, transformation, loading, and scheduling code belongs in the data pipeline code repository documented in `infrastructure.md`. The scratchpad is for exploration, not production code. If a prototype script in the scratchpad matures into reusable pipeline code, graduate it to the pipelines repository as an explicit step.

## File Storage

Scratchpad files live under `~/.system2/`:

| Location | When to use |
|----------|-------------|
| `~/.system2/projects/{id}_{name}/scratchpad/` | Working files tied to a specific project. Default for any work happening inside a project. |
| `~/.system2/scratchpad/` | Working files not associated with any project (one-off explorations, system-wide experiments, generic prototypes). |

There are no subdirectory conventions: agents organize the contents of these directories as they see fit for the work at hand. There is no automatic cleanup; files persist indefinitely. Both directories are gitignored by the default `.gitignore` template installed in `~/.system2/` (see `packages/server/src/knowledge/git.ts`), so scratchpad files do not appear in `git -C ~/.system2 status` and never get committed to the knowledge repo.

## Recommendations for Intermediate Data

When an exploration produces a Python object, DataFrame, or query result that may be reloaded later (in another step, another script, or another session) without recomputing from scratch, snapshot it to disk in the scratchpad. Recommended formats:

- **`df.to_parquet()`** for pandas/polars DataFrames: compact, typed, fast to read back, language-portable. The default choice for tabular data.
- **`pickle`** for arbitrary Python objects (models, dicts of arrays, custom classes) when parquet does not fit. Pickle is Python-only and version-sensitive: prefer parquet whenever the data is tabular.
- **JSON** for small structured data (config-like dicts, small lists of records) where human-readability matters more than performance.

These snapshots avoid re-running expensive queries or recomputing transforms across separate tool calls and let later work resume from a known state.

## Recommendations for Notebooks

Jupyter notebooks (`.ipynb`) are a natural fit for exploratory analysis with mixed code, prose, and inline plots. The recommended workflow:

1. Author the source `.ipynb` in the scratchpad (project-scoped or project-free as appropriate).
2. Run cells iteratively, or execute the whole notebook with `jupyter nbconvert --execute notebook.ipynb` (or similar) to populate outputs.
3. When the notebook is ready to be shown to the user, render it to HTML with `jupyter nbconvert --to html notebook.ipynb`.
4. Copy the HTML into the appropriate `artifacts/` directory (project-scoped or project-free).
5. Register it as an artifact in the database (`createArtifact` via the `write_system2_db` tool), using an absolute `file_path`.
6. Display it with `show_artifact` for the user.

The source `.ipynb` stays in the scratchpad as the editable working copy; the HTML in the appropriate `artifacts/` directory is the published deliverable. This separation lets the agent keep iterating on the source without disturbing the published version, and lets the user see the rendered output without needing a Jupyter server.

## Promotion to Artifacts

Promotion is an explicit step, not an automatic one. When something in the scratchpad becomes a deliverable the user should see (a finished plot, a polished report, a rendered notebook, a usable export):

1. Copy the file from the scratchpad to the appropriate `artifacts/` directory (project-scoped or project-free).
2. Register the artifact in the database with `createArtifact`, providing `file_path`, `title`, optional `description`, and optional `tags`.
3. Optionally call `show_artifact` to display it to the user immediately.

The scratchpad copy stays as the working version. If the artifact needs further iteration, the agent edits the scratchpad source, re-renders or re-exports, and overwrites the artifact file. The database record tracks the title and metadata; the file at `file_path` is the live published version.

If the same exploration also produced reusable pipeline code, graduate that code to the data pipelines repository as a separate step (see `infrastructure.md` for the repository location).

## Lifecycle and Cleanup

Scratchpad files persist indefinitely. There is no automatic cleanup, retention policy, or expiry. The intent is that working files remain available for as long as they might be useful: a parquet snapshot taken last week may still be the right starting point this week.

Agents may delete their own scratchpad files when they are confident the files are no longer needed (e.g., a prototype that has been graduated to a pipeline, or a cache for a query that has since been re-run from a different source). When in doubt, leave the file in place.

## See Also

- [Artifacts](artifacts.md): the published-deliverable counterpart, with database registration and UI rendering
- [Agents](agents.md): the agent-facing scratchpad instructions in the shared system prompt
- [Knowledge System](knowledge-system.md): how the broader `~/.system2/` directory is structured and git-tracked
