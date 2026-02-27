/**
 * WebSocket Handler
 *
 * Bridges Pi Agent events to WebSocket clients for real-time chat UI updates.
 */

import type { WebSocket } from 'ws';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type { ClientMessage, ServerMessage } from '@system2/shared';
import type { AgentHost } from '../agents/host.js';

export class WebSocketHandler {
  private ws: WebSocket;
  private agentHost: AgentHost;
  private unsubscribe?: () => void;

  constructor(ws: WebSocket, agentHost: AgentHost) {
    this.ws = ws;
    this.agentHost = agentHost;

    // Subscribe to agent events
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
      case 'user_message':
        // Send user message to agent
        this.agentHost.prompt(message.content).catch((error) => {
          console.error('Agent prompt failed:', error);
          this.sendError('Failed to process message');
        });
        break;

      case 'abort':
        this.agentHost.abort();
        break;

      default:
        this.sendError(`Unknown message type: ${(message as any).type}`);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_update':
        // Stream text as it's generated
        if (event.assistantMessageEvent.type === 'text_delta') {
          this.send({
            type: 'assistant_chunk',
            content: event.assistantMessageEvent.delta,
          });
        }
        break;

      case 'message_end':
        // End of assistant message
        this.send({ type: 'assistant_end' });
        break;

      case 'tool_execution_start':
        this.send({
          type: 'tool_call_start',
          name: event.toolName,
        });
        break;

      case 'tool_execution_end':
        // Format result as string for display
        let resultText = '';
        if (event.result?.content) {
          resultText = event.result.content
            .map((c: any) => (c.type === 'text' ? c.text : ''))
            .join('');
        }

        this.send({
          type: 'tool_call_end',
          name: event.toolName,
          result: event.isError ? `Error: ${resultText}` : resultText,
        });
        break;

      case 'agent_end':
        // Agent finished processing
        console.log('Agent finished. Stop reason:', this.agentHost.state.stopReason);
        break;

      default:
        // Log other events for debugging
        console.log('Agent event:', event.type);
    }
  }

  private send(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendError(message: string): void {
    this.send({ type: 'error', message });
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}
