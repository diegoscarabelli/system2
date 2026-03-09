/**
 * System2 Gateway Server
 *
 * HTTP + WebSocket server that hosts the Guide and Narrator agents and serves the UI.
 */

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

    // Serve artifact files from ~/.system2/
    this.app.use(
      '/artifacts',
      express.static(SYSTEM2_DIR, {
        dotfiles: 'deny',
        setHeaders: (res) => {
          res.setHeader('Cache-Control', 'no-cache');
        },
      })
    );

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
   * Create a spawner callback that creates, initializes, and registers new AgentHost instances.
   * The spawner is self-referential: spawned agents (Conductors) receive the same spawner so
   * they can in turn spawn specialist sub-agents and Reviewers.
   */
  private makeSpawner(): AgentSpawner {
    const spawner: AgentSpawner = async (role, projectId, callerAgentId, initialMessage) => {
      // Create agent record in DB
      const newAgent = this.db.createAgent({ role, project: projectId, status: 'active' });

      // Create new AgentHost with identical config + recursive spawner
      const newHost = new AgentHost({
        db: this.db,
        agentId: newAgent.id,
        registry: this.agentRegistry,
        llmConfig: this.config.llmConfig,
        servicesConfig: this.config.servicesConfig,
        toolsConfig: this.config.toolsConfig,
        spawner, // recursive — Conductors can spawn sub-agents
      });

      await newHost.initialize();
      this.agentRegistry.register(newAgent.id, newHost);

      // Deliver the initial message from the caller
      await newHost.deliverMessage(initialMessage, {
        sender: callerAgentId,
        receiver: newAgent.id,
        timestamp: Date.now(),
      });

      return newAgent.id;
    };

    return spawner;
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
