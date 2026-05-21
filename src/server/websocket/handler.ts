/**
 * WebSocket Handler
 *
 * Bridges Pi Agent events to WebSocket clients for real-time chat UI updates.
 * Supports multi-agent routing: the user can switch the active chat to any agent.
 *
 * Chat row delivery is unified via `chat_message_added`: any push to the agent's
 * chatCache (user input, history-capture's finalized assistant turns, LLM-error
 * system rows, failover system rows, compaction system rows) is forwarded live
 * to all subscribed clients. The UI mirrors chatCache exactly. Streaming events
 * (assistant_chunk, tool_call_*) drive the transient draft above the committed
 * messages list; they don't represent committed rows.
 */

import { randomUUID } from 'node:crypto';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/index.js';
import type { AgentHost } from '../agents/host.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ConversationSummarizer } from '../chat/summarizer.js';
import { log } from '../utils/logger.js';

/**
 * Validate a client-provided ChatMessage id before persisting + rebroadcasting.
 * Caps length and restricts to a safe charset so a malicious or buggy client
 * can't (a) bloat chatCache with multi-MB ids, (b) inject control chars into
 * persisted JSON or log lines, or (c) deliberately collide ids and trigger
 * silent drops via the UI's dedup-by-id. Anything that fails this check is
 * replaced with a server-generated UUID.
 */
const MAX_CLIENT_ID_LENGTH = 128;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
function isValidClientMessageId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_CLIENT_ID_LENGTH &&
    CLIENT_ID_PATTERN.test(id)
  );
}

export class WebSocketHandler {
  private ws: WebSocket;
  private agentRegistry: AgentRegistry;
  private guideAgentId: number;
  private activeAgentId: number;
  private subscriptions = new Map<number, () => void>();
  private thinkingAgents = new Set<number>();
  private summarizer?: ConversationSummarizer;

  constructor(
    ws: WebSocket,
    agentRegistry: AgentRegistry,
    guideAgentId: number,
    summarizer?: ConversationSummarizer
  ) {
    this.ws = ws;
    this.agentRegistry = agentRegistry;
    this.guideAgentId = guideAgentId;
    this.activeAgentId = guideAgentId;
    this.summarizer = summarizer;

    // Get Guide's host
    const guideHost = this.agentRegistry.get(guideAgentId);
    if (!guideHost) {
      this.sendError('Guide agent not found');
      ws.close();
      return;
    }

    // Subscribe BEFORE sending the snapshot so the chatCache listener is
    // installed first. This matches the switch_agent ordering and guarantees
    // we never miss a push that lands after the snapshot is taken but before
    // the subscription is wired up. The dedup-by-id in the UI's appendMessage
    // handles any row that appears both in the snapshot and in a live
    // chat_message_added event during the overlap window.
    this.subscribeToAgent(guideAgentId, guideHost);

    // Send Guide's chat cache and provider info on connect
    this.send({
      type: 'chat_history',
      messages: guideHost.chatCache.getMessages(),
      agentId: guideAgentId,
    });
    this.send({ type: 'provider_info', provider: guideHost.getProvider(), agentId: guideAgentId });

    // Seed Guide's busy/context state into the client's push store so
    // MessageInput's contextPercent is populated before the first turn ends.
    this.sendAgentBusySnapshot(guideAgentId, guideHost);

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
   * Subscribe to an agent's events AND chatCache pushes for streaming to this
   * WebSocket client. Subscriptions are kept alive across agent switches so
   * events continue flowing for background agents (preserving in-progress tool
   * calls, etc.) and committed rows reach the UI without waiting for a reload.
   */
  private subscribeToAgent(agentId: number, host: AgentHost): void {
    // Already subscribed to this agent
    if (this.subscriptions.has(agentId)) return;

    const unsubEvents = host.subscribe((event) => {
      this.handleAgentEvent(event, agentId, host);
    });
    const unsubCache = host.chatCache.subscribe((message) => {
      this.send({ type: 'chat_message_added', message, agentId });
    });
    this.subscriptions.set(agentId, () => {
      unsubEvents();
      unsubCache();
    });
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

        const isSteering = message.type === 'steering_message';

        // Steering interrupts an in-flight assistant turn. Commit whatever
        // the SDK has accumulated so far into chatCache FIRST, so the
        // persisted order is [assistant_partial, user_steering] rather than
        // racing the SDK's eventual message_end against this user push.
        // No-op when nothing is in flight.
        if (isSteering) {
          host.flushPartialTurn();
        }

        // Capture user message in agent's chat cache. The push fires
        // chat_message_added to every subscribed client (including this one),
        // so the originating tab's optimistic insert dedups against the same id.
        // Validate the client-provided id: a too-long or off-charset id would
        // persist as-is and rebroadcast to every other tab. Fall back to a
        // server-generated UUID on anything invalid.
        const id = isValidClientMessageId(message.id) ? message.id : `msg-${randomUUID()}`;
        host.chatCache.push({
          id,
          role: 'user',
          content: message.content,
          timestamp: Date.now(),
        });

        // Record for summarization (non-Guide agents only)
        if (this.summarizer && targetId !== this.guideAgentId) {
          this.summarizer.recordUserMessage(targetId, host.role ?? 'unknown', message.content);
        }

        // Send to agent
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
          this.send({
            type: 'error',
            message: `Agent ${newAgentId} not found or terminated`,
            agentId: newAgentId,
          });
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

        // Seed this client's busy/context state for the new agent — drives both
        // AgentPane and MessageInput via the same push-store entry.
        this.sendAgentBusySnapshot(newAgentId, host);

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
      const statusEvent = event as unknown as { provider?: string };
      if (statusEvent.provider) {
        // The chat row describing the switch is delivered separately via the
        // chat_message_added stream (pushed by reinitializeWithProvider). This
        // event exists solely to refresh the UI's provider indicator.
        this.send({
          type: 'provider_change',
          provider: statusEvent.provider,
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
        // Stream-over signal for the UI's draft state. LLM error rows are
        // pushed into chatCache by history-capture and arrive via
        // chat_message_added — they don't ride along on assistant_end.
        this.send({ type: 'assistant_end', agentId });
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

        // If show_artifact completed successfully, emit artifact message
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

        // Context usage delivery is handled by AgentHost.onBusyChange (busy=false)
        // broadcasting agent_busy_state — single source of truth for both AgentPane
        // and MessageInput.

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

  private sendError(message: string): void {
    this.send({ type: 'error', message });
  }

  /**
   * Unicast snapshot of an agent's current busy + context state to this client.
   * Mirrors what a server-side agent_busy_state broadcast delivers; used to seed
   * the client's push store on initial connect (for the Guide) and on switch_agent
   * (for the newly focused agent) before any busy transition has occurred.
   */
  private sendAgentBusySnapshot(agentId: number, host: AgentHost): void {
    this.send({
      type: 'agent_busy_state',
      agentId,
      busy: host.isBusy(),
      contextPercent: host.getContextUsage()?.percent ?? null,
    });
  }

  private cleanup(): void {
    for (const unsub of this.subscriptions.values()) {
      unsub();
    }
    this.subscriptions.clear();
    this.thinkingAgents.clear();
  }
}
