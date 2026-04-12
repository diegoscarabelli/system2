/**
 * WebSocket Handler
 *
 * Bridges Pi Agent events to WebSocket clients for real-time chat UI updates.
 * Supports multi-agent routing: the user can switch the active chat to any agent.
 * User messages are captured in the agent's chat cache and broadcast to other tabs.
 * Assistant message history capture is handled centrally by Server.
 */

import { type FSWatcher, watch } from 'node:fs';
import type { ClientMessage, ServerMessage } from '@dscarabelli/shared';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AgentHost } from '../agents/host.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ConversationSummarizer } from '../chat/summarizer.js';
import { log } from '../utils/logger.js';

export class WebSocketHandler {
  private ws: WebSocket;
  private agentRegistry: AgentRegistry;
  private guideAgentId: number;
  private wss: WebSocketServer;
  private activeAgentId: number;
  private subscriptions = new Map<number, () => void>();
  private thinkingAgents = new Set<number>();
  private artifactWatcher?: FSWatcher;
  private artifactUrl?: string;
  private summarizer?: ConversationSummarizer;

  constructor(
    ws: WebSocket,
    agentRegistry: AgentRegistry,
    guideAgentId: number,
    wss: WebSocketServer,
    summarizer?: ConversationSummarizer
  ) {
    this.ws = ws;
    this.agentRegistry = agentRegistry;
    this.guideAgentId = guideAgentId;
    this.wss = wss;
    this.activeAgentId = guideAgentId;
    this.summarizer = summarizer;

    // Get Guide's host
    const guideHost = this.agentRegistry.get(guideAgentId);
    if (!guideHost) {
      this.sendError('Guide agent not found');
      ws.close();
      return;
    }

    // Send Guide's chat cache and provider info on connect
    this.send({
      type: 'chat_history',
      messages: guideHost.chatCache.getMessages(),
      agentId: guideAgentId,
    });
    this.send({ type: 'provider_info', provider: guideHost.getProvider(), agentId: guideAgentId });

    // Subscribe to Guide's events for streaming to this client
    this.subscribeToAgent(guideAgentId, guideHost);

    // Handle incoming messages from client
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(message);
      } catch (error) {
        log.error('Failed to parse client message:', error);
        this.sendError('Invalid message format');
      }
    });

    // Clean up on disconnect
    ws.on('close', () => {
      this.cleanup();
    });

    ws.on('error', (error) => {
      log.error('WebSocket error:', error);
      this.cleanup();
    });
  }

  /**
   * Subscribe to an agent's events for streaming to this WebSocket client.
   * Subscriptions are kept alive across agent switches so events continue
   * flowing for background agents (preserving in-progress tool calls, etc.).
   */
  private subscribeToAgent(agentId: number, host: AgentHost): void {
    // Already subscribed to this agent
    if (this.subscriptions.has(agentId)) return;

    this.subscriptions.set(
      agentId,
      host.subscribe((event) => {
        this.handleAgentEvent(event, agentId, host);
      })
    );
  }

  private handleClientMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'user_message':
      case 'steering_message': {
        // Resolve target agent (default to active agent)
        const targetId = message.agentId ?? this.activeAgentId;
        const host = this.agentRegistry.get(targetId);
        if (!host) {
          this.sendError(`Agent ${targetId} not found`);
          return;
        }

        // Capture user message in agent's chat cache
        const userMsg = {
          id: `msg-${Date.now()}`,
          role: 'user' as const,
          content: message.content,
          timestamp: Date.now(),
        };
        host.chatCache.push(userMsg);

        // Broadcast to other tabs
        this.broadcast({
          type: 'user_message_broadcast',
          id: userMsg.id,
          content: userMsg.content,
          timestamp: userMsg.timestamp,
          agentId: targetId,
        });

        // Record for summarization (non-Guide agents only)
        if (this.summarizer && targetId !== this.guideAgentId) {
          this.summarizer.recordUserMessage(targetId, host.role ?? 'unknown', message.content);
        }

        // Send to agent
        const isSteering = message.type === 'steering_message';
        host
          .prompt(message.content, isSteering ? { isSteering: true } : undefined)
          .catch((error) => {
            log.error('Agent prompt failed:', error);
            this.sendError('Failed to process message');
          });
        break;
      }

      case 'abort': {
        const targetId = message.agentId ?? this.activeAgentId;
        const host = this.agentRegistry.get(targetId);
        if (host) host.abort();
        break;
      }

      case 'switch_agent': {
        const newAgentId = message.agentId;
        const host = this.agentRegistry.get(newAgentId);
        if (!host) {
          this.sendError(`Agent ${newAgentId} not found or terminated`);
          return;
        }

        // Update active agent and subscribe to its events
        this.activeAgentId = newAgentId;
        this.subscribeToAgent(newAgentId, host);

        // Send new agent's chat cache and provider
        this.send({
          type: 'chat_history',
          messages: host.chatCache.getMessages(),
          agentId: newAgentId,
        });
        this.send({ type: 'provider_info', provider: host.getProvider(), agentId: newAgentId });

        // Send context usage for the new agent
        const usage = host.getContextUsage();
        if (usage) {
          this.send({
            type: 'context_usage',
            percent: usage.percent,
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            agentId: newAgentId,
          });
        }

        // Send ready_for_input if the agent is idle
        if (!host.isBusy()) {
          this.send({ type: 'ready_for_input', agentId: newAgentId });
        }

        break;
      }

      default:
        this.sendError(`Unknown message type: ${(message as Record<string, unknown>).type}`);
    }
  }

  private handleAgentEvent(event: AgentSessionEvent, agentId: number, host: AgentHost): void {
    // Handle synthetic events (not part of AgentSessionEvent type)
    const eventType = event.type as string;
    if (eventType === 'status') {
      const statusEvent = event as unknown as { provider?: string; reason?: string };
      if (statusEvent.provider) {
        this.send({
          type: 'provider_change',
          provider: statusEvent.provider,
          reason: statusEvent.reason,
          agentId,
        });
      }
      return;
    }

    switch (event.type) {
      case 'message_update':
        // Stream text as it's generated
        if (event.assistantMessageEvent.type === 'text_delta') {
          if (this.thinkingAgents.has(agentId)) {
            this.send({ type: 'thinking_end', agentId });
            this.thinkingAgents.delete(agentId);
          }
          this.send({
            type: 'assistant_chunk',
            content: event.assistantMessageEvent.delta,
            agentId,
          });
        }
        // Stream thinking blocks
        else if (event.assistantMessageEvent.type === 'thinking_delta') {
          this.thinkingAgents.add(agentId);
          this.send({
            type: 'thinking_chunk',
            content: event.assistantMessageEvent.delta,
            agentId,
          });
        }
        break;

      case 'message_end': {
        if (this.thinkingAgents.has(agentId)) {
          this.send({ type: 'thinking_end', agentId });
          this.thinkingAgents.delete(agentId);
        }
        // Forward error info so the UI can render it in the chat timeline
        const messageData = (
          event as unknown as { message?: { stopReason?: string; errorMessage?: string } }
        ).message;
        const errorMessage =
          messageData?.stopReason === 'error' ? messageData.errorMessage : undefined;
        this.send({ type: 'assistant_end', agentId, errorMessage });
        break;
      }

      case 'tool_execution_start': {
        if (this.thinkingAgents.has(agentId)) {
          this.send({ type: 'thinking_end', agentId });
          this.thinkingAgents.delete(agentId);
        }
        // Format tool input for display
        let inputText = '';
        const rawInput = event.args;
        if (rawInput) {
          try {
            inputText = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2);
          } catch {
            inputText = String(rawInput);
          }
        }

        this.send({
          type: 'tool_call_start',
          name: event.toolName,
          input: inputText,
          agentId,
        });
        break;
      }

      case 'tool_execution_update': {
        // Forward heartbeat progress events to the UI (skip regular streaming updates)
        const partialResult = (
          event as unknown as { partialResult?: { details?: Record<string, unknown> } }
        ).partialResult;
        const details = partialResult?.details;
        if (details?.heartbeat && typeof details.heartbeatMessage === 'string') {
          this.send({
            type: 'tool_call_progress',
            name: event.toolName,
            message: details.heartbeatMessage,
            agentId,
          });
        }
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

        this.send({
          type: 'tool_call_end',
          name: event.toolName,
          result: finalResult,
          agentId,
        });

        // If show_artifact completed successfully, emit artifact message and watch
        if (event.toolName === 'show_artifact' && !event.isError) {
          const details = event.result?.details as
            | { url?: string; absolutePath?: string; title?: string }
            | undefined;
          log.info('[WebSocket] show_artifact result:', JSON.stringify(event.result));
          if (details?.url && details?.absolutePath) {
            this.send({
              type: 'artifact',
              url: details.url,
              title: details.title,
              filePath: details.absolutePath,
            });
            this.watchArtifact(details.url, details.absolutePath);
          } else {
            log.warn('[WebSocket] show_artifact missing details:', details);
          }
        }
        break;
      }

      case 'agent_end': {
        // Agent finished processing
        log.info(
          'Agent finished. Stop reason:',
          (host.state as unknown as Record<string, unknown>).stopReason
        );

        // Send context usage update
        const usage = host.getContextUsage();
        if (usage) {
          this.send({
            type: 'context_usage',
            percent: usage.percent,
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            agentId,
          });
        }

        // Signal that the agent is ready for the next message
        this.send({ type: 'ready_for_input', agentId });
        break;
      }

      case 'compaction_start':
        this.send({ type: 'compaction_start', agentId });
        break;

      case 'compaction_end':
        this.send({ type: 'compaction_end', agentId });
        break;

      default:
        // Log other events for debugging
        log.info('Agent event:', event.type);
    }
  }

  /** Send a message to this client only. */
  private send(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Send a message to all other connected clients (excluding this one). */
  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client !== this.ws && client.readyState === this.ws.OPEN) {
        client.send(data);
      }
    }
  }

  private sendError(message: string): void {
    this.send({ type: 'error', message });
  }

  private watchArtifact(url: string, absolutePath: string): void {
    // Stop previous watcher if any
    if (this.artifactWatcher) {
      this.artifactWatcher.close();
    }

    this.artifactUrl = url;
    log.info('[WebSocket] Watching artifact:', absolutePath);

    try {
      this.artifactWatcher = watch(absolutePath, (eventType, filename) => {
        log.info('[WebSocket] fs.watch event:', eventType, filename);
        if (eventType === 'change') {
          // Cache-bust so the iframe actually reloads (use & since URL already has ?path=)
          const separator = this.artifactUrl?.includes('?') ? '&' : '?';
          const bustUrl = `${this.artifactUrl}${separator}t=${Date.now()}`;
          log.info('[WebSocket] Sending artifact reload:', bustUrl);
          this.send({ type: 'artifact', url: bustUrl, filePath: absolutePath });
        }
      });

      this.artifactWatcher.on('error', (err) => {
        log.error('[WebSocket] Watcher error:', err);
      });
    } catch (error) {
      log.error('[WebSocket] Failed to watch artifact:', error);
    }
  }

  private cleanup(): void {
    if (this.artifactWatcher) {
      this.artifactWatcher.close();
      this.artifactWatcher = undefined;
    }
    for (const unsub of this.subscriptions.values()) {
      unsub();
    }
    this.subscriptions.clear();
    this.thinkingAgents.clear();
  }
}
