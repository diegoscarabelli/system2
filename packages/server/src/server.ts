/**
 * System2 Gateway Server
 *
 * HTTP + WebSocket server that hosts the Guide and Narrator agents and serves the UI.
 */

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmConfig, SchedulerConfig, ServicesConfig, ToolsConfig } from '@system2/shared';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AgentHost } from './agents/host.js';
import { AgentRegistry } from './agents/registry.js';
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

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    this.db = new DatabaseClient(config.dbPath);

    // Initialize knowledge directory and git repo (idempotent)
    initializeKnowledge(SYSTEM2_DIR);
    initializeGitRepo(SYSTEM2_DIR);

    // Initialize agent registry
    this.agentRegistry = new AgentRegistry();

    // Initialize Guide agent (singleton)
    const guideAgent = this.db.getOrCreateGuideAgent();
    this.agentHost = new AgentHost({
      db: this.db,
      agentId: guideAgent.id,
      registry: this.agentRegistry,
      llmConfig: config.llmConfig,
      servicesConfig: config.servicesConfig,
      toolsConfig: config.toolsConfig,
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
      new WebSocketHandler(ws, this.agentHost);
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
