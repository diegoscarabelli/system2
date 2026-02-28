/**
 * System2 Gateway Server
 *
 * HTTP + WebSocket server that hosts the Guide agent and serves the UI.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseClient } from './db/client.js';
import { AgentHost } from './agents/host.js';
import { WebSocketHandler } from './websocket/handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerConfig {
  port: number;
  dbPath: string;
  llmProvider: 'anthropic' | 'openai' | 'google';
  uiDistPath?: string;
}

export class Server {
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private db: DatabaseClient;
  private agentHost: AgentHost;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    this.db = new DatabaseClient(config.dbPath);

    // Initialize agent host (reads model from agent library)
    this.agentHost = new AgentHost({
      db: this.db,
      llmProvider: config.llmProvider,
    });

    // Set up Express app
    this.app = express();
    this.app.use(express.json());

    // Serve UI static files (if path provided)
    if (config.uiDistPath) {
      this.app.use(express.static(config.uiDistPath));
      this.app.get('*', (req, res) => {
        res.sendFile(join(config.uiDistPath!, 'index.html'));
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
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => {
        console.log(`System2 Gateway running on http://localhost:${this.config.port}`);
        console.log(`WebSocket server ready`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
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
