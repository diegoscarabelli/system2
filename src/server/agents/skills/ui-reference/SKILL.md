---
name: ui-reference
description: System2 UI layout and panel reference. Read this when the user asks about the interface, when you need to direct them to a specific panel, or when you need to describe what they are seeing.
roles: [guide]
---

# UI Reference

The user interacts with System2 through a multi-panel UI. Understanding the layout lets you give accurate directions (e.g. "check the Board tab", "you'll see the artifact open in the viewer").

## Layout

- **Sidebar** (left): icon buttons toggle between panels (Artifact Catalog, Agents, Board, Cron Jobs, Particles effect, Theme). Clicking an icon opens a resizable drawer with that panel's content. Side drawers are mutually exclusive: opening one closes the other. All panel data comes from app.db, so keeping database records accurate directly affects what the user sees.
- **Artifact Viewer** (center): tabbed area where HTML artifacts and the Kanban Board are displayed. Each artifact opens in its own tab. HTML artifacts run in sandboxed iframes with full JS execution: they can embed inline data, fetch from accessible endpoints, or query app.db via a postMessage bridge. Agents can build interactive data applications as self-contained HTML files.
- **Chat Panel** (right, ~33% width): the conversation with the active agent. The user can switch to any agent's chat by clicking on it in the Agents panel. The status bar shows the current LLM provider and context usage percentage. Resizable.

## Chat Panel

- **Message history**: user messages labeled "You", agent messages labeled by role. Messages from other agents (inter-agent deliveries) also appear in the history. All messages render as full markdown (headings, code blocks, lists, links).
- **Thinking blocks**: shown inline as collapsible cards. The user can expand them to read your reasoning.
- **Tool calls**: shown inline as collapsible cards with tool name, input parameters, and output. The user sees what tools you invoke and the results.
- **System messages**: collapsible cards showing error details, provider failovers, and key rotations. The title summarizes the event; the body has provider-specific details.
- **Context meter**: circular indicator showing how much of the LLM context window is used. Teal below 40%, accent at 40-49%, red at 50%+. The tight threshold exists because per-minute token rate limits tend to be on the same order of magnitude as the context window, so multiple agents calling in the same minute can exhaust the quota. Compaction fires early to keep headroom.
- **Message input**: text area at the bottom. While you are responding, user messages are sent as steering messages that interrupt the current turn.

## Artifact Catalog (Side Drawer)

Searchable library of all registered artifacts, grouped by project. The user can search by title/description and filter by project or tag. Clicking an artifact opens it in the Artifact Viewer. When you use `show_artifact`, the artifact opens here.

## Agent Pane (Side Drawer)

Live table of all agents grouped by project (system agents listed separately). Shows each agent's ID, role, context window usage (%), and busy/idle state. Clicking an agent switches the Chat Panel to that agent's conversation. Point users here when they ask which agents are running or want to check on a specific agent's activity.

## Cron Jobs Panel

Table of scheduler job executions. Shows job name, status (completed, failed, running, skipped), trigger type (cron, catch-up, manual), and start/end times. Filterable by job name, status, and trigger type. Sortable by any column. Clicking a row opens execution details. Point users here when they ask about scheduled job history or want to check whether recent cron runs succeeded.

## Kanban Board

Task management dashboard displayed in the Artifact Viewer. Shows:

- **Filter toolbar**: keyword search, plus multiselect dropdowns for priority, assignee (`role_id`, e.g. `conductor_3`), labels, and status. The status filter controls which columns are visible.
- **Swimlanes**: one row per project, with columns for Todo, In Progress, Review, Done, and Abandoned. Done/abandoned projects auto-collapse.
- **Task cards**: show title, priority (color-coded left border), labels, and assignee (`role_id`). Clicking a card opens a detail modal with all fields, description, related task links, and comments.
- **Project info**: clicking the info icon on a swimlane header opens a detail modal with the project's status, labels, start/end dates, and description.
- Progress bar per project showing completion ratio.
