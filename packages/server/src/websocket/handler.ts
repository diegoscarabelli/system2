/**
 * WebSocket Handler
 *
 * Bridges Pi Agent events to WebSocket clients for real-time chat UI updates.
 */

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { ClientMessage, ServerMessage } from '@system2/shared';
import type { WebSocket } from 'ws';
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

      case 'steering_message':
        // Send steering message (inserted ASAP into the agent loop)
        this.agentHost.prompt(message.content, { isSteering: true }).catch((error) => {
          console.error('Agent steering prompt failed:', error);
          this.sendError('Failed to process steering message');
        });
        break;

      case 'abort':
        this.agentHost.abort();
        break;

      default:
        this.sendError(`Unknown message type: ${(message as any).type}`);
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
        // End of assistant message
        this.send({ type: 'assistant_end' });
        break;

      case 'tool_execution_start': {
        // Format tool input for display - check multiple possible properties
        // Pi Agent uses 'args' for tool input, not 'toolInput'
        let inputText = '';
        const rawInput = event.toolInput ?? (event as any).args;
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
            .map((c: any) => (c.type === 'text' ? c.text : ''))
            .join('');
        }

        this.send({
          type: 'tool_call_end',
          name: event.toolName,
          result: event.isError ? `Error: ${resultText}` : resultText,
        });
        break;
      }

      case 'agent_end':
        // Agent finished processing
        console.log('Agent finished. Stop reason:', (this.agentHost.state as any).stopReason);
        // Signal that the agent is ready for the next message
        this.send({ type: 'ready_for_input' });
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
