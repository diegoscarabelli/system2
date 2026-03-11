/**
 * WebSocket Handler
 *
 * Bridges Pi Agent events to WebSocket clients for real-time chat UI updates.
 * User messages are captured here and broadcast to other connected tabs.
 * Assistant message history capture is handled centrally by Server.
 */

import { type FSWatcher, watch } from 'node:fs';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { ClientMessage, ServerMessage } from '@system2/shared';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AgentHost } from '../agents/host.js';
import type { MessageHistory } from '../chat/history.js';

export class WebSocketHandler {
  private ws: WebSocket;
  private agentHost: AgentHost;
  private history: MessageHistory;
  private wss: WebSocketServer;
  private unsubscribe?: () => void;
  private artifactWatcher?: FSWatcher;
  private artifactUrl?: string;

  constructor(ws: WebSocket, agentHost: AgentHost, history: MessageHistory, wss: WebSocketServer) {
    this.ws = ws;
    this.agentHost = agentHost;
    this.history = history;
    this.wss = wss;

    // Send chat history on connect — server is the source of truth
    this.send({ type: 'chat_history', messages: history.getMessages() });

    // Subscribe to agent events for streaming to this client
    this.unsubscribe = agentHost.subscribe((event) => {
      this.handleAgentEvent(event);
    });

    // Handle incoming messages from client
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(message);
      } catch (error) {
        console.error('Failed to parse client message:', error);
        this.sendError('Invalid message format');
      }
    });

    // Clean up on disconnect
    ws.on('close', () => {
      this.cleanup();
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.cleanup();
    });
  }

  private handleClientMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'user_message': {
        // Capture user message in history and broadcast to other tabs
        const userMsg = {
          id: `msg-${Date.now()}`,
          role: 'user' as const,
          content: message.content,
          timestamp: Date.now(),
        };
        this.history.push(userMsg);
        this.broadcast({
          type: 'user_message_broadcast',
          id: userMsg.id,
          content: userMsg.content,
          timestamp: userMsg.timestamp,
        });

        // Send user message to agent
        this.agentHost.prompt(message.content).catch((error) => {
          console.error('Agent prompt failed:', error);
          this.sendError('Failed to process message');
        });
        break;
      }

      case 'steering_message': {
        // Capture steering message in history (still a user message) and broadcast
        const steerMsg = {
          id: `msg-${Date.now()}`,
          role: 'user' as const,
          content: message.content,
          timestamp: Date.now(),
        };
        this.history.push(steerMsg);
        this.broadcast({
          type: 'user_message_broadcast',
          id: steerMsg.id,
          content: steerMsg.content,
          timestamp: steerMsg.timestamp,
        });

        // Send steering message (inserted ASAP into the agent loop)
        this.agentHost.prompt(message.content, { isSteering: true }).catch((error) => {
          console.error('Agent steering prompt failed:', error);
          this.sendError('Failed to process steering message');
        });
        break;
      }

      case 'abort':
        this.agentHost.abort();
        break;

      default:
        this.sendError(`Unknown message type: ${(message as Record<string, unknown>).type}`);
    }
  }

  private handleAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_update':
        // Stream text as it's generated
        if (event.assistantMessageEvent.type === 'text_delta') {
          this.send({
            type: 'assistant_chunk',
            content: event.assistantMessageEvent.delta,
          });
        }
        // Stream thinking blocks
        else if (event.assistantMessageEvent.type === 'thinking_delta') {
          this.send({
            type: 'thinking_chunk',
            content: event.assistantMessageEvent.delta,
          });
        }
        break;

      case 'message_end':
        this.send({ type: 'assistant_end' });
        break;

      case 'tool_execution_start': {
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

        this.send({
          type: 'tool_call_end',
          name: event.toolName,
          result: finalResult,
        });

        // If show_artifact completed successfully, emit artifact message and watch for changes
        if (event.toolName === 'show_artifact' && !event.isError) {
          const details = event.result?.details as
            | { url?: string; absolutePath?: string; title?: string }
            | undefined;
          console.log('[WebSocket] show_artifact result:', JSON.stringify(event.result));
          if (details?.url && details?.absolutePath) {
            this.send({
              type: 'artifact',
              url: details.url,
              title: details.title,
              filePath: details.absolutePath,
            });
            this.watchArtifact(details.url, details.absolutePath);
          } else {
            console.warn('[WebSocket] show_artifact missing details:', details);
          }
        }
        break;
      }

      case 'agent_end': {
        // Agent finished processing
        console.log(
          'Agent finished. Stop reason:',
          (this.agentHost.state as unknown as Record<string, unknown>).stopReason
        );

        // Send context usage update
        const usage = this.agentHost.getContextUsage();
        if (usage) {
          this.send({
            type: 'context_usage',
            percent: usage.percent,
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
          });
        }

        // Signal that the agent is ready for the next message
        this.send({ type: 'ready_for_input' });
        break;
      }

      default:
        // Log other events for debugging
        console.log('Agent event:', event.type);
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
    console.log('[WebSocket] Watching artifact:', absolutePath);

    try {
      this.artifactWatcher = watch(absolutePath, (eventType, filename) => {
        console.log('[WebSocket] fs.watch event:', eventType, filename);
        if (eventType === 'change') {
          // Cache-bust so the iframe actually reloads (use & since URL already has ?path=)
          const separator = this.artifactUrl?.includes('?') ? '&' : '?';
          const bustUrl = `${this.artifactUrl}${separator}t=${Date.now()}`;
          console.log('[WebSocket] Sending artifact reload:', bustUrl);
          this.send({ type: 'artifact', url: bustUrl, filePath: absolutePath });
        }
      });

      this.artifactWatcher.on('error', (err) => {
        console.error('[WebSocket] Watcher error:', err);
      });
    } catch (error) {
      console.error('[WebSocket] Failed to watch artifact:', error);
    }
  }

  private cleanup(): void {
    if (this.artifactWatcher) {
      this.artifactWatcher.close();
      this.artifactWatcher = undefined;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}
