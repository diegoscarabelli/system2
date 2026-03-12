/**
 * System2 Gateway Server
 *
 * HTTP + WebSocket server that hosts the Guide and Narrator agents and serves the UI.
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type {
  ChatConfig,
  ChatMessage,
  ChatTurnEvent,
  LlmConfig,
  SchedulerConfig,
  ServicesConfig,
  ToolsConfig,
} from '@system2/shared';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AgentHost } from './agents/host.js';
import { AgentRegistry } from './agents/registry.js';
import type { AgentSpawner } from './agents/tools/spawn-agent.js';
import { MessageHistory } from './chat/history.js';
import { DatabaseClient } from './db/client.js';
import { initializeGitRepo } from './knowledge/git.js';
import { initializeKnowledge } from './knowledge/init.js';
import {
  buildAndDeliverDailySummary,
  registerNarratorJobs,
  resolveDailySummaryTimestamp,
} from './scheduler/jobs.js';
import { Scheduler } from './scheduler/scheduler.js';
import { WebSocketHandler } from './websocket/handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');

export interface ServerConfig {
  port: number;
  dbPath: string;
  uiDistPath?: string;
  llmConfig: LlmConfig;
  servicesConfig?: ServicesConfig;
  toolsConfig?: ToolsConfig;
  schedulerConfig?: SchedulerConfig;
  chatConfig?: ChatConfig;
}

export class Server {
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private db: DatabaseClient;
  private agentHost: AgentHost;
  private narratorHost: AgentHost;
  private agentRegistry: AgentRegistry;
  private scheduler: Scheduler;
  private config: ServerConfig;
  private narratorId: number;
  private messageHistory: MessageHistory;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    this.db = new DatabaseClient(config.dbPath);

    // Initialize knowledge directory and git repo (idempotent)
    initializeKnowledge(SYSTEM2_DIR);
    initializeGitRepo(SYSTEM2_DIR);

    // Initialize agent registry
    this.agentRegistry = new AgentRegistry();

    // Initialize Guide agent (singleton) — receives the spawner so it can create Conductors/Reviewers
    const guideAgent = this.db.getOrCreateGuideAgent();
    this.agentHost = new AgentHost({
      db: this.db,
      agentId: guideAgent.id,
      registry: this.agentRegistry,
      llmConfig: config.llmConfig,
      servicesConfig: config.servicesConfig,
      toolsConfig: config.toolsConfig,
      spawner: this.makeSpawner(),
      onArtifactChange: () => this.broadcastCatalogChanged(),
      onTaskChange: () => this.broadcastTasksChanged(),
      onBusyChange: () => this.broadcastAgentsChanged(),
    });
    this.agentRegistry.register(guideAgent.id, this.agentHost);

    // Initialize Narrator agent (singleton)
    const narratorAgent = this.db.getOrCreateNarratorAgent();
    this.narratorId = narratorAgent.id;
    this.narratorHost = new AgentHost({
      db: this.db,
      agentId: narratorAgent.id,
      registry: this.agentRegistry,
      llmConfig: config.llmConfig,
      servicesConfig: config.servicesConfig,
      toolsConfig: config.toolsConfig,
      onArtifactChange: () => this.broadcastCatalogChanged(),
      onTaskChange: () => this.broadcastTasksChanged(),
      onBusyChange: () => this.broadcastAgentsChanged(),
    });
    this.agentRegistry.register(narratorAgent.id, this.narratorHost);

    // Initialize chat history (server-side, persisted to disk)
    const maxMessages = config.chatConfig?.max_history_messages ?? 100;
    this.messageHistory = new MessageHistory(join(SYSTEM2_DIR, 'chat-history.json'), maxMessages);

    // Single subscriber for capturing assistant messages into history.
    // This runs once regardless of how many WebSocket clients are connected,
    // preventing duplicate entries when multiple tabs are open.
    this.subscribeForHistoryCapture(this.agentHost);

    // Initialize scheduler
    this.scheduler = new Scheduler();

    // Set up Express app
    this.app = express();
    this.app.use(express.json());

    // Serve artifact files from anywhere on the filesystem
    this.app.get('/api/artifact', (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      let resolved = filePath;
      if (resolved.startsWith('~/')) {
        resolved = join(homedir(), resolved.slice(2));
      }
      resolved = normalize(resolved);

      if (!isAbsolute(resolved)) {
        res.status(400).json({ error: 'Path must be absolute' });
        return;
      }

      if (!existsSync(resolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolved);
    });

    // List all registered artifacts for the catalog UI
    this.app.get('/api/artifacts', (_req, res) => {
      try {
        const artifacts = this.db.query(
          'SELECT a.*, p.name AS project_name FROM artifact a LEFT JOIN project p ON a.project = p.id ORDER BY a.created_at DESC'
        );
        res.json({ artifacts });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // List all non-archived agents with their busy state for the agents pane
    this.app.get('/api/agents', (_req, res) => {
      try {
        const agents = this.db.query(
          "SELECT a.id, a.role, a.project, a.status, a.created_at, p.name AS project_name FROM agent a LEFT JOIN project p ON a.project = p.id WHERE a.status != 'archived' ORDER BY a.id"
        ) as (import('@system2/shared').Agent & { project_name: string | null })[];

        const result = agents.map((agent) => ({
          ...agent,
          busy: this.agentRegistry.get(agent.id)?.isBusy() ?? false,
        }));

        res.json({ agents: result });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Kanban board data — all tasks with project + assignee info, all projects, all agents
    this.app.get('/api/kanban', (_req, res) => {
      try {
        const tasks = this.db.query(`
          SELECT t.id, t.parent, t.project, t.title, t.description,
                 t.status, t.priority, t.assignee, t.labels,
                 t.start_at, t.end_at, t.created_at,
                 p.name AS project_name, a.role AS assignee_role
          FROM task t
          LEFT JOIN project p ON t.project = p.id
          LEFT JOIN agent a ON t.assignee = a.id
          ORDER BY t.created_at ASC
        `);
        const projects = this.db.query(`
          SELECT * FROM project
          ORDER BY
            CASE status WHEN 'done' THEN 1 WHEN 'abandoned' THEN 2 ELSE 0 END,
            created_at ASC
        `);
        const agents = this.db.query("SELECT id, role, project FROM agent WHERE status = 'active'");
        res.json({ tasks, projects, agents });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Task detail — full task with comments and links
    this.app.get('/api/tasks/:id', (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
          res.status(400).json({ error: 'Invalid task id' });
          return;
        }
        const [task] = this.db.query(
          `SELECT t.*, p.name AS project_name, a.role AS assignee_role
           FROM task t
           LEFT JOIN project p ON t.project = p.id
           LEFT JOIN agent a ON t.assignee = a.id
           WHERE t.id = ?`,
          [id]
        );
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        const comments = this.db.query(
          `SELECT tc.*, ag.role AS author_role
           FROM task_comment tc JOIN agent ag ON tc.author = ag.id
           WHERE tc.task = ? ORDER BY tc.created_at ASC`,
          [id]
        );
        const links = this.db.query(
          `SELECT tl.id, tl.relationship, tl.target AS linked_task_id,
                  t.title AS linked_task_title, t.status AS linked_task_status,
                  'outgoing' AS direction
           FROM task_link tl JOIN task t ON tl.target = t.id WHERE tl.source = ?
           UNION ALL
           SELECT tl.id, tl.relationship, tl.source AS linked_task_id,
                  t.title AS linked_task_title, t.status AS linked_task_status,
                  'incoming' AS direction
           FROM task_link tl JOIN task t ON tl.source = t.id WHERE tl.target = ?`,
          [id, id]
        );
        res.json({ task, comments, links });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Query API for interactive artifact dashboards (postMessage bridge)
    this.app.post('/api/query', (req, res) => {
      try {
        const { sql } = req.body;
        if (!sql || typeof sql !== 'string') {
          res.status(400).json({ error: 'Missing or invalid sql parameter' });
          return;
        }
        const trimmed = sql.trim().toUpperCase();
        if (!trimmed.startsWith('SELECT')) {
          res.status(403).json({ error: 'Only SELECT queries are allowed' });
          return;
        }
        const rows = this.db.query(sql);
        res.json({ rows, count: rows.length });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Serve UI static files (if path provided)
    if (config.uiDistPath) {
      this.app.use(express.static(config.uiDistPath));
      this.app.get('*', (_req, res) => {
        res.sendFile(join(config.uiDistPath as string, 'index.html'));
      });
    }

    // Create HTTP server
    this.httpServer = createServer(this.app);

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });

    // Handle WebSocket connections
    this.wss.on('connection', (ws) => {
      console.log('Client connected');
      new WebSocketHandler(ws, this.agentHost, this.messageHistory, this.wss);
    });
  }

  /**
   * Initialize an AgentHost for a given agent ID, register it, and return it.
   * Single path for all non-singleton agent initialization (spawn + restore).
   */
  private async initializeAgentHost(agentId: number): Promise<AgentHost> {
    const host = new AgentHost({
      db: this.db,
      agentId,
      registry: this.agentRegistry,
      llmConfig: this.config.llmConfig,
      servicesConfig: this.config.servicesConfig,
      toolsConfig: this.config.toolsConfig,
      spawner: this.makeSpawner(),
      onArtifactChange: () => this.broadcastCatalogChanged(),
      onTaskChange: () => this.broadcastTasksChanged(),
      onBusyChange: () => this.broadcastAgentsChanged(),
    });

    await host.initialize();
    this.agentRegistry.register(agentId, host);
    return host;
  }

  /**
   * Create a spawner callback that creates, initializes, and registers new AgentHost instances.
   * The spawner is self-referential: spawned agents (Conductors) receive the same spawner so
   * they can in turn spawn specialist sub-agents and Reviewers.
   */
  private makeSpawner(): AgentSpawner {
    const spawner: AgentSpawner = async (role, projectId, callerAgentId, initialMessage) => {
      // Create agent record in DB
      const newAgent = this.db.createAgent({ role, project: projectId, status: 'active' });

      const newHost = await this.initializeAgentHost(newAgent.id);

      // Deliver the initial message from the caller (fire-and-forget)
      newHost.deliverMessage(initialMessage, {
        sender: callerAgentId,
        receiver: newAgent.id,
        timestamp: Date.now(),
      });

      return newAgent.id;
    };

    return spawner;
  }

  private broadcastCatalogChanged(): void {
    const data = JSON.stringify({ type: 'catalog_changed' });
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  private broadcastTasksChanged(): void {
    const data = JSON.stringify({ type: 'tasks_changed' });
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  private broadcastAgentsChanged(): void {
    const context: Record<number, number | null> = {};
    for (const [id, host] of this.agentRegistry.entries()) {
      context[id] = host.getContextUsage()?.percent ?? null;
    }
    const data = JSON.stringify({ type: 'agents_changed', context });
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Subscribe once to agent events for history capture.
   * Accumulates thinking blocks and tool calls as turn events,
   * then persists the complete assistant message on message_end.
   */
  private subscribeForHistoryCapture(agentHost: AgentHost): void {
    let currentAssistantText = '';
    let activeThinkingContent = '';
    let currentTurnEvents: ChatTurnEvent[] = [];

    agentHost.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'text_delta') {
            currentAssistantText += event.assistantMessageEvent.delta;
          } else if (event.assistantMessageEvent.type === 'thinking_delta') {
            activeThinkingContent += event.assistantMessageEvent.delta;
          }
          break;

        case 'message_end': {
          // Finalize thinking if active
          if (activeThinkingContent) {
            currentTurnEvents.push({
              type: 'thinking',
              data: {
                id: `thinking-${Date.now()}`,
                content: activeThinkingContent,
                isStreaming: false,
                timestamp: Date.now(),
              },
            });
            activeThinkingContent = '';
          }

          // Capture completed assistant message in history
          if (currentAssistantText) {
            const assistantMsg: ChatMessage = {
              id: `msg-${Date.now()}`,
              role: 'assistant',
              content: currentAssistantText,
              timestamp: Date.now(),
              turnEvents: currentTurnEvents.length > 0 ? [...currentTurnEvents] : undefined,
            };
            this.messageHistory.push(assistantMsg);
            currentAssistantText = '';
            currentTurnEvents = [];
          }
          break;
        }

        case 'tool_execution_start': {
          // Finalize thinking before tool call
          if (activeThinkingContent) {
            currentTurnEvents.push({
              type: 'thinking',
              data: {
                id: `thinking-${Date.now()}`,
                content: activeThinkingContent,
                isStreaming: false,
                timestamp: Date.now(),
              },
            });
            activeThinkingContent = '';
          }

          // Format tool input for display
          let inputText = '';
          const rawInput = event.args;
          if (rawInput) {
            try {
              inputText =
                typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2);
            } catch {
              inputText = String(rawInput);
            }
          }

          currentTurnEvents.push({
            type: 'tool_call',
            data: {
              id: `tool-${Date.now()}`,
              name: event.toolName,
              status: 'running',
              input: inputText,
              timestamp: Date.now(),
            },
          });
          break;
        }

        case 'tool_execution_end': {
          // Format result as string for display
          let resultText = '';
          if (event.result?.content) {
            resultText = event.result.content
              .map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : ''))
              .join('');
          }
          const finalResult = event.isError ? `Error: ${resultText}` : resultText;

          // Update the tool call in turn events (immutable)
          let matched = false;
          currentTurnEvents = currentTurnEvents.map((e) => {
            if (
              !matched &&
              e.type === 'tool_call' &&
              e.data.name === event.toolName &&
              e.data.status === 'running'
            ) {
              matched = true;
              return {
                ...e,
                data: { ...e.data, status: 'completed' as const, result: finalResult },
              };
            }
            return e;
          });
          break;
        }
      }
    });
  }

  async start(): Promise<void> {
    // Initialize agent sessions
    await this.agentHost.initialize();
    await this.narratorHost.initialize();

    // Restore previously active spawned agents (conductors, reviewers, etc.)
    await this.restoreActiveAgents();

    // Start scheduled jobs
    const intervalMinutes = this.config.schedulerConfig?.daily_summary_interval_minutes ?? 30;
    registerNarratorJobs(
      this.scheduler,
      this.narratorHost,
      this.narratorId,
      this.db,
      SYSTEM2_DIR,
      intervalMinutes
    );

    // Check if narrator needs catch-up after sleep/shutdown
    this.checkNarratorCatchUp();

    // Graceful shutdown handlers
    const shutdown = async () => {
      console.log('Shutting down...');
      await this.stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => {
        console.log(`System2 Gateway running on http://localhost:${this.config.port}`);
        console.log(`WebSocket server ready`);
        resolve();
      });
    });
  }

  /**
   * Check if the Narrator missed scheduled work (e.g., after laptop sleep/shutdown).
   * Croner does NOT catch up missed jobs, so we check timestamps on startup.
   */
  private checkNarratorCatchUp(): void {
    const intervalMinutes = this.config.schedulerConfig?.daily_summary_interval_minutes ?? 30;
    const { lastRunTs } = resolveDailySummaryTimestamp(SYSTEM2_DIR, intervalMinutes);

    if (!lastRunTs) {
      console.log('[Server] First run, skipping narrator catch-up');
      return;
    }

    const staleness = Date.now() - new Date(lastRunTs).getTime();
    if (staleness > intervalMinutes * 60 * 1000) {
      console.log(
        `[Server] Narrator stale by ${Math.round(staleness / 60000)} min, queuing catch-up`
      );
      buildAndDeliverDailySummary(
        this.db,
        this.narratorHost,
        this.narratorId,
        SYSTEM2_DIR,
        intervalMinutes
      );
    }
  }

  /**
   * Restore spawned agents that were active before the last shutdown.
   * Re-creates their AgentHost, initializes the session, and registers them.
   */
  private async restoreActiveAgents(): Promise<void> {
    const agents = this.db.query(
      "SELECT * FROM agent WHERE status != 'archived' AND role NOT IN ('guide', 'narrator') ORDER BY id"
    ) as import('@system2/shared').Agent[];
    if (agents.length === 0) return;

    console.log(`[Server] Restoring ${agents.length} agent(s)...`);

    for (const agent of agents) {
      try {
        await this.initializeAgentHost(agent.id);
        console.log(`[Server] Restored ${agent.role} agent (id=${agent.id})`);
      } catch (error) {
        console.error(`[Server] Failed to restore ${agent.role} agent (id=${agent.id}):`, error);

        // Notify the Guide about the restore failure (agent stays active in DB)
        const errorMsg =
          `Failed to restore ${agent.role} agent (id=${agent.id}): ${(error as Error).message}. ` +
          `The agent record is still active in the database but has no running session. ` +
          `Investigate and decide whether to retry or archive the agent.`;
        this.agentHost.deliverMessage(errorMsg, {
          sender: agent.id,
          receiver: this.agentHost.agentId,
          timestamp: Date.now(),
        });
      }
    }
  }

  async stop(): Promise<void> {
    // Stop scheduled jobs first
    this.scheduler.stop();

    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        this.httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          this.db.close();
          resolve();
        });
      });
    });
  }
}
