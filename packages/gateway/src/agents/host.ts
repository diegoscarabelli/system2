/**
 * Agent Host
 *
 * Manages the Guide agent session using Pi SDK.
 */

import { Agent, type AgentEvent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DatabaseClient } from '../db/client.js';
import { createQueryDatabaseTool } from './tools/query-database.js';
import { createBashTool } from './tools/bash.js';
import { createReadTool } from './tools/read.js';
import { createWriteTool } from './tools/write.js';

const SYSTEM2_DIR = join(homedir(), '.system2');
const GUIDE_AGENT_DIR = join(SYSTEM2_DIR, 'agents', 'guide');

interface GuideConfig {
  name: string;
  description: string;
  version: string;
  models: {
    anthropic: string;
    openai: string;
    google: string;
  };
}

export interface AgentHostConfig {
  db: DatabaseClient;
  llmProvider: string;
  sessionPath?: string;
}

export class AgentHost {
  private agent: Agent;
  private db: DatabaseClient;
  private listeners: Set<(event: AgentEvent) => void> = new Set();

  constructor(config: AgentHostConfig) {
    this.db = config.db;

    // Load Guide agent configuration from library
    const guideConfigPath = join(GUIDE_AGENT_DIR, 'config.json');
    const guideConfig: GuideConfig = JSON.parse(readFileSync(guideConfigPath, 'utf-8'));

    // Get model for selected provider from agent library config
    const llmModel = guideConfig.models[config.llmProvider as keyof typeof guideConfig.models];
    if (!llmModel) {
      throw new Error(`No model configured for provider: ${config.llmProvider}`);
    }

    // Load Guide system prompt from library
    const systemPromptPath = join(GUIDE_AGENT_DIR, 'system.md');
    const systemPrompt = readFileSync(systemPromptPath, 'utf-8');

    // Initialize LLM model
    const model = getModel(config.llmProvider as any, llmModel);

    // Create Guide agent with tools
    this.agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [
          createQueryDatabaseTool(this.db),
          createBashTool(),
          createReadTool(),
          createWriteTool(),
          // TODO: Add spawn_conductor tool (Phase 2)
        ],
        thinkingLevel: 'off',
      },
      // TODO: Configure session persistence via sessionPath
    });

    // Subscribe to agent events and forward to listeners
    this.agent.subscribe((event) => {
      this.listeners.forEach((listener) => listener(event));
    });
  }

  /**
   * Subscribe to agent events
   */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Send a message to the agent
   */
  async prompt(content: string): Promise<void> {
    await this.agent.prompt([
      {
        role: 'user',
        content,
        timestamp: Date.now(),
      },
    ]);
  }

  /**
   * Abort current execution
   */
  abort(): void {
    this.agent.abort();
  }

  /**
   * Get current agent state
   */
  get state() {
    return this.agent.state;
  }
}
