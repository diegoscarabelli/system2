/**
 * System2 Gateway Server
 *
 * HTTP + WebSocket server that hosts the Guide and Narrator agents and serves the UI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmConfig, ServicesConfig, ToolsConfig } from '@system2/shared';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AgentHost } from './agents/host.js';
import { AgentRegistry } from './agents/registry.js';
import { DatabaseClient } from './db/client.js';
import { initializeGitRepo } from './knowledge/git.js';
import { initializeKnowledge } from './knowledge/init.js';
import { registerNarratorJobs } from './scheduler/jobs.js';
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
    registerNarratorJobs(this.scheduler, this.narratorHost, this.narratorId);

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
    const today = new Date().toISOString().slice(0, 10);
    const dailyLogPath = join(SYSTEM2_DIR, 'knowledge', 'memory', `${today}.md`);

    let lastNarrated: Date | null = null;

    if (existsSync(dailyLogPath)) {
      // Read frontmatter from today's daily log
      const content = readFileSync(dailyLogPath, 'utf-8');
      const match = content.match(/^---\s*\nlast_narrated:\s*(.+)\s*\n---/);
      if (match) {
        lastNarrated = new Date(match[1]);
      }
    } else {
      // No daily log for today — check memory.md for last_restructured
      const memoryPath = join(SYSTEM2_DIR, 'knowledge', 'memory.md');
      if (existsSync(memoryPath)) {
        const content = readFileSync(memoryPath, 'utf-8');
        const match = content.match(/^---\s*\nlast_restructured:\s*(.+)\s*\n---/);
        if (match) {
          lastNarrated = new Date(match[1]);
        }
      }
    }

    if (!lastNarrated) {
      // No timestamps found — first run, queue narration
      console.log('[Server] No narration timestamps found, queuing initial daily log');
      this.narratorHost.deliverMessage(
        "[Scheduled task: daily-log]\n\nAppend to today's daily log. This is the first run — create the daily log file and capture any existing activity.",
        { sender: 0, receiver: this.narratorId, timestamp: Date.now() }
      );
      return;
    }

    const staleness = Date.now() - lastNarrated.getTime();
    const thirtyMinutes = 30 * 60 * 1000;

    if (staleness > thirtyMinutes) {
      console.log(
        `[Server] Narrator is stale by ${Math.round(staleness / 60000)} minutes, queuing catch-up`
      );
      this.narratorHost.deliverMessage(
        "[Scheduled task: daily-log]\n\nAppend to today's daily log. Read activity since last_narrated timestamp. This is a catch-up after server restart.",
        { sender: 0, receiver: this.narratorId, timestamp: Date.now() }
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
