/**
 * System2 Gateway Server
 *
 * HTTP + WebSocket server that hosts the Guide and Narrator agents and serves the UI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChatConfig,
  JobExecution,
  LlmConfig,
  SchedulerConfig,
  ServicesConfig,
  ToolsConfig,
} from '@dscarabelli/shared';
import type { Api, Model } from '@mariozechner/pi-ai';
import { type AgentSessionEvent, ModelRegistry } from '@mariozechner/pi-coding-agent';
import express from 'express';
import matter from 'gray-matter';
import { WebSocketServer } from 'ws';
import { AuthResolver } from './agents/auth-resolver.js';
import { AgentHost } from './agents/host.js';
import { AgentRegistry } from './agents/registry.js';
import type { AgentResurrector } from './agents/tools/resurrect-agent.js';
import type { AgentSpawner } from './agents/tools/spawn-agent.js';
import { createHistoryCaptureSubscriber } from './chat/history-capture.js';
import { ConversationSummarizer } from './chat/summarizer.js';
import { DatabaseClient } from './db/client.js';
import { initializeGitRepo } from './knowledge/git.js';
import { initializeKnowledge } from './knowledge/init.js';
import { ReminderManager } from './reminders/manager.js';
import {
  buildAndDeliverDailySummary,
  buildAndDeliverMemoryUpdate,
  readFrontmatterField,
  registerNarratorJobs,
  resolveDailySummaryTimestamp,
  trackJobExecution,
} from './scheduler/jobs.js';
import { isNetworkAvailable } from './scheduler/network.js';
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
  private guideAgentId: number;
  private conversationSummarizer?: ConversationSummarizer;
  private authResolver: AuthResolver;
  private reminderManager: ReminderManager;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    this.db = new DatabaseClient(config.dbPath);

    // Initialize knowledge directory and git repo (idempotent)
    initializeKnowledge(SYSTEM2_DIR);
    initializeGitRepo(SYSTEM2_DIR);

    // Initialize agent registry
    this.agentRegistry = new AgentRegistry();

    // Shared AuthResolver: all agents see the same cooldown/failover state
    this.authResolver = new AuthResolver(config.llmConfig);

    // Shared ReminderManager: all agents schedule reminders through the same instance
    this.reminderManager = new ReminderManager(this.agentRegistry);

    // Initialize Guide agent (singleton) — receives the spawner so it can create Conductors/Reviewers
    const chatMaxMessages = config.chatConfig?.max_history_messages ?? 1000;

    const guideAgent = this.db.getOrCreateGuideAgent();
    this.guideAgentId = guideAgent.id;
    this.agentHost = new AgentHost({
      db: this.db,
      agentId: guideAgent.id,
      registry: this.agentRegistry,
      llmConfig: config.llmConfig,
      servicesConfig: config.servicesConfig,
      toolsConfig: config.toolsConfig,
      spawner: this.makeSpawner(),
      resurrector: this.makeResurrector(),
      chatMaxMessages,
      authResolver: this.authResolver,
      reminderManager: this.reminderManager,
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
      chatMaxMessages,
      authResolver: this.authResolver,
      reminderManager: this.reminderManager,
    });
    this.agentRegistry.register(narratorAgent.id, this.narratorHost);

    // Subscribe singleton agents for chat cache capture.
    // Each agent's chatCache (created during initialize()) persists messages to disk.
    // Subscription is set up before initialize() so no events are missed.
    this.subscribeForHistoryCapture(this.agentHost);
    this.subscribeForHistoryCapture(this.narratorHost);

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
        ) as (import('@dscarabelli/shared').Agent & { project_name: string | null })[];

        const result = agents.map((agent) => {
          const host = this.agentRegistry.get(agent.id);
          return {
            ...agent,
            busy: host?.isBusy() ?? false,
            contextPercent: host?.getContextUsage()?.percent ?? null,
          };
        });

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
        const agents = this.db.query('SELECT id, role, project FROM agent');
        res.json({ tasks, projects, agents });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Job execution history
    this.app.get('/api/job-executions', (req, res) => {
      try {
        const jobName = req.query.job_name as string | undefined;
        const status = req.query.status as string | undefined;
        const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
        if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
          res.status(400).json({ error: 'Invalid limit. Must be a positive integer.' });
          return;
        }
        const limit = rawLimit !== undefined ? Math.min(rawLimit, 500) : undefined;

        const validStatuses = ['running', 'completed', 'failed', 'skipped'] as const;
        if (status && !validStatuses.includes(status as (typeof validStatuses)[number])) {
          res
            .status(400)
            .json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
          return;
        }

        const executions = this.db.listJobExecutions({
          jobName: jobName || undefined,
          status: (status as JobExecution['status']) || undefined,
          limit,
        });

        res.json({ executions });
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
      new WebSocketHandler(
        ws,
        this.agentRegistry,
        this.guideAgentId,
        this.wss,
        this.conversationSummarizer
      );
    });
  }

  /**
   * Initialize an AgentHost for a given agent ID, register it, and return it.
   * Single path for all non-singleton agent initialization (spawn + restore).
   */
  private async initializeAgentHost(agentId: number): Promise<AgentHost> {
    const chatMaxMessages = this.config.chatConfig?.max_history_messages ?? 1000;
    const host = new AgentHost({
      db: this.db,
      agentId,
      registry: this.agentRegistry,
      llmConfig: this.config.llmConfig,
      servicesConfig: this.config.servicesConfig,
      toolsConfig: this.config.toolsConfig,
      spawner: this.makeSpawner(),
      resurrector: this.makeResurrector(),
      chatMaxMessages,
      authResolver: this.authResolver,
      reminderManager: this.reminderManager,
    });

    // Subscribe for chat cache capture before initialize() so no events are missed
    this.subscribeForHistoryCapture(host);
    await host.initialize();
    this.agentRegistry.register(agentId, host);

    // Subscribe spawned agents for summarizer capture (non-Guide only)
    this.subscribeForSummarizerCapture(host);

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
      newHost
        .deliverMessage(initialMessage, {
          sender: callerAgentId,
          receiver: newAgent.id,
          timestamp: Date.now(),
        })
        .catch((err) => console.error('[Server] spawner delivery failed:', err));

      return newAgent.id;
    };

    return spawner;
  }

  /**
   * Create a resurrector callback that re-initializes archived agents.
   * Reuses initializeAgentHost which resumes from persisted JSONL sessions.
   */
  private makeResurrector(): AgentResurrector {
    return async (agentId, callerAgentId, message) => {
      const host = await this.initializeAgentHost(agentId);

      host
        .deliverMessage(message, {
          sender: callerAgentId,
          receiver: agentId,
          timestamp: Date.now(),
        })
        .catch((err) => console.error('[Server] resurrector delivery failed:', err));
    };
  }

  /**
   * Subscribe once to agent events for history capture.
   * Accumulates thinking blocks and tool calls as turn events,
   * then persists the complete assistant message on message_end.
   */
  private subscribeForHistoryCapture(agentHost: AgentHost): void {
    agentHost.subscribe(createHistoryCaptureSubscriber(agentHost.chatCache));
  }

  async start(): Promise<void> {
    // Initialize agent sessions
    await this.agentHost.initialize();
    await this.narratorHost.initialize();

    // Initialize conversation summarizer (uses narrator's model for cheap summarization)
    try {
      const narratorModel = this.resolveNarratorModel();
      if (narratorModel) {
        this.conversationSummarizer = new ConversationSummarizer(
          this.agentHost,
          this.guideAgentId,
          narratorModel.registry,
          narratorModel.model
        );
        // Subscribe non-Guide agents for summarizer event capture
        this.subscribeForSummarizerCapture(this.narratorHost);
        console.log('[Server] Conversation summarizer initialized');
      }
    } catch (err) {
      console.warn('[Server] Failed to initialize conversation summarizer:', err);
    }

    // Restore previously active spawned agents (conductors, reviewers, etc.)
    await this.restoreActiveAgents();

    // Mark any stale 'running' job executions from a previous crash as failed
    const staleCount = this.db.failStaleJobExecutions('server shutdown');
    if (staleCount > 0) {
      console.log(`[Server] Recovered ${staleCount} stale job execution(s) from previous process`);
    }

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

    // Check if narrator needs catch-up after sleep/shutdown.
    // Fire-and-forget: don't block the HTTP server from starting.
    this.checkNarratorCatchUp().catch((err) =>
      console.error('[Server] Narrator catch-up failed:', err)
    );

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
  private async checkNarratorCatchUp(): Promise<void> {
    if (!(await isNetworkAvailable())) {
      console.log('[Server] No network connectivity, skipping narrator catch-up');
      return;
    }

    const intervalMinutes = this.config.schedulerConfig?.daily_summary_interval_minutes ?? 30;

    // Daily summary catch-up
    const { lastRunTs } = resolveDailySummaryTimestamp(SYSTEM2_DIR, intervalMinutes);
    if (!lastRunTs) {
      console.log('[Server] No daily summary timestamps found, skipping daily-summary catch-up');
    } else {
      const staleness = Date.now() - new Date(lastRunTs).getTime();
      if (staleness > intervalMinutes * 60 * 1000) {
        console.log(
          `[Server] Daily summary stale by ${Math.round(staleness / 60000)} min, queuing catch-up`
        );
        try {
          await trackJobExecution(this.db, 'daily-summary', 'catch-up', () =>
            buildAndDeliverDailySummary(
              this.db,
              this.narratorHost,
              this.narratorId,
              SYSTEM2_DIR,
              intervalMinutes
            )
          );
        } catch (error) {
          console.error('[Server] Daily summary catch-up failed:', error);
        }
      }
    }

    // Memory update catch-up (must be queued after daily-summary so the Narrator
    // processes summaries first, then incorporates them into memory)
    const memoryFile = join(SYSTEM2_DIR, 'knowledge', 'memory.md');
    const memoryTs = readFrontmatterField(memoryFile, 'last_narrator_update_ts');
    if (memoryTs) {
      const memoryStaleness = Date.now() - new Date(memoryTs).getTime();
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      if (memoryStaleness > ONE_DAY_MS) {
        console.log(
          `[Server] Memory stale by ${Math.round(memoryStaleness / 3600000)}h, queuing memory-update catch-up`
        );
        try {
          await trackJobExecution(this.db, 'memory-update', 'catch-up', () =>
            buildAndDeliverMemoryUpdate(this.narratorHost, this.narratorId, SYSTEM2_DIR)
          );
        } catch (error) {
          console.error('[Server] Memory update catch-up failed:', error);
        }
      }
    }
  }

  /**
   * Restore spawned agents that were active before the last shutdown.
   * Re-creates their AgentHost, initializes the session, and registers them.
   */
  private async restoreActiveAgents(): Promise<void> {
    const agents = this.db.query(
      "SELECT * FROM agent WHERE status != 'archived' AND role NOT IN ('guide', 'narrator') ORDER BY id"
    ) as import('@dscarabelli/shared').Agent[];
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
        this.agentHost
          .deliverMessage(errorMsg, {
            sender: agent.id,
            receiver: this.agentHost.agentId,
            timestamp: Date.now(),
          })
          .catch((err) => console.error('[Server] restore error delivery failed:', err));
      }
    }
  }

  /**
   * Resolve the Narrator's model from its frontmatter for use by the ConversationSummarizer.
   * Returns the model and a ModelRegistry, or null if resolution fails.
   */
  private resolveNarratorModel(): { model: Model<Api>; registry: ModelRegistry } | null {
    // Agent definition files are co-located with AgentHost (dist/agents/library/)
    const agentDir = join(dirname(fileURLToPath(import.meta.url)), 'agents');
    const narratorPath = join(agentDir, 'library', 'narrator.md');

    if (!existsSync(narratorPath)) {
      console.warn('[Server] Narrator definition not found at', narratorPath);
      return null;
    }

    const { data: meta } = matter(readFileSync(narratorPath, 'utf-8'));
    const models = meta.models as Record<string, string> | undefined;
    if (!models) return null;

    const modelRegistry = new ModelRegistry(this.authResolver.createAuthStorage());

    for (const provider of this.authResolver.providerOrder) {
      const modelId = models[provider];
      if (modelId) {
        const model = modelRegistry.find(provider, modelId);
        if (model) return { model, registry: modelRegistry };
      }
    }

    console.warn('[Server] No narrator model found for any configured provider');
    return null;
  }

  /**
   * Subscribe an agent's events to the ConversationSummarizer for thinking/tool/reply capture.
   * Only subscribes non-Guide agents (Guide interactions don't need summarization).
   */
  private subscribeForSummarizerCapture(agentHost: AgentHost): void {
    if (!this.conversationSummarizer) return;
    if (agentHost.agentId === this.guideAgentId) return;

    const summarizer = this.conversationSummarizer;
    const agentId = agentHost.agentId;

    let thinkingBuffer = '';
    let replyBuffer = '';

    agentHost.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'thinking_delta') {
            thinkingBuffer += event.assistantMessageEvent.delta;
          } else if (event.assistantMessageEvent.type === 'text_delta') {
            replyBuffer += event.assistantMessageEvent.delta;
          }
          break;

        case 'message_end':
          if (thinkingBuffer) {
            summarizer.recordAgentEvent(agentId, {
              type: 'thinking',
              content: thinkingBuffer,
              timestamp: Date.now(),
            });
            thinkingBuffer = '';
          }
          if (replyBuffer) {
            summarizer.recordAgentEvent(agentId, {
              type: 'assistant_reply',
              content: replyBuffer,
              timestamp: Date.now(),
            });
            replyBuffer = '';
          }
          break;

        case 'tool_execution_start': {
          if (thinkingBuffer) {
            summarizer.recordAgentEvent(agentId, {
              type: 'thinking',
              content: thinkingBuffer,
              timestamp: Date.now(),
            });
            thinkingBuffer = '';
          }
          let inputText = '';
          try {
            inputText = typeof event.args === 'string' ? event.args : JSON.stringify(event.args);
          } catch {
            inputText = String(event.args);
          }
          summarizer.recordAgentEvent(agentId, {
            type: 'tool_call',
            content: `${event.toolName}: ${inputText}`,
            timestamp: Date.now(),
          });
          break;
        }
      }
    });
  }

  async stop(): Promise<void> {
    // Clean up conversation summarizer
    this.conversationSummarizer?.cleanup();

    // Stop reminder timers and scheduled jobs
    this.reminderManager.stop();
    this.scheduler.stop();

    // Initiate clean WebSocket close handshake with all clients
    for (const client of this.wss.clients) {
      client.close(1001, 'server shutting down');
    }

    // Allow 2s for clean close, then force-terminate stragglers
    const graceTimer = setTimeout(() => {
      for (const client of this.wss.clients) {
        client.terminate();
      }
    }, 2000);

    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        clearTimeout(graceTimer);
        if (err) {
          reject(err);
          return;
        }

        // Force-drop lingering HTTP keep-alive connections
        this.httpServer.closeAllConnections();
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
