/**
 * Conversation Summarizer
 *
 * Summarizes user interactions with non-Guide agents and delivers summaries
 * to the Guide agent. Uses a non-resetting 1-minute timer: on first user message
 * to a non-Guide agent, a timer starts. On expiry, buffered events are summarized
 * via a one-shot LLM call and delivered to the Guide. A new timer starts only if
 * additional user messages arrived during the timer period.
 */

import type { Api, Model } from '@mariozechner/pi-ai';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { AgentHost } from '../agents/host.js';
import { oneShotComplete } from '../llm/oneshot.js';
import { log } from '../utils/logger.js';

export interface BufferedEvent {
  type: 'user_message' | 'thinking' | 'tool_call' | 'assistant_reply';
  content: string;
  timestamp: number;
}

interface AgentBuffer {
  agentId: number;
  agentRole: string;
  events: BufferedEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  timerStartEventCount: number; // number of events when the timer was started
}

export class ConversationSummarizer {
  private buffers: Map<number, AgentBuffer> = new Map();
  private guideHost: AgentHost;
  private guideAgentId: number;
  private modelRegistry: ModelRegistry;
  private narratorModel: Model<Api>;

  static readonly TIMER_DURATION_MS = 60_000;

  constructor(
    guideHost: AgentHost,
    guideAgentId: number,
    modelRegistry: ModelRegistry,
    narratorModel: Model<Api>
  ) {
    this.guideHost = guideHost;
    this.guideAgentId = guideAgentId;
    this.modelRegistry = modelRegistry;
    this.narratorModel = narratorModel;
  }

  /**
   * Record a user message sent to a non-Guide agent.
   * Starts the summary timer on first message (does not reset on subsequent messages).
   */
  recordUserMessage(agentId: number, agentRole: string, content: string): void {
    const buffer = this.getOrCreateBuffer(agentId, agentRole);
    buffer.events.push({ type: 'user_message', content, timestamp: Date.now() });

    // Start timer on first message (non-resetting)
    if (buffer.timer === null) {
      buffer.timerStartEventCount = buffer.events.length;
      buffer.timer = setTimeout(
        () => this.onTimerExpiry(agentId),
        ConversationSummarizer.TIMER_DURATION_MS
      );
    }
  }

  /**
   * Record an agent event (thinking, tool call, or reply) for summarization.
   * Only recorded if a buffer exists for this agent (i.e., user has messaged it).
   */
  recordAgentEvent(agentId: number, event: BufferedEvent): void {
    const buffer = this.buffers.get(agentId);
    if (!buffer) return;
    buffer.events.push(event);
  }

  private getOrCreateBuffer(agentId: number, agentRole: string): AgentBuffer {
    let buffer = this.buffers.get(agentId);
    if (!buffer) {
      buffer = {
        agentId,
        agentRole,
        events: [],
        timer: null,
        timerStartEventCount: 0,
      };
      this.buffers.set(agentId, buffer);
    }
    return buffer;
  }

  private async onTimerExpiry(agentId: number): Promise<void> {
    const buffer = this.buffers.get(agentId);
    if (!buffer || buffer.events.length === 0) {
      if (buffer) buffer.timer = null;
      return;
    }

    // Format events into a readable log
    const formattedLog = buffer.events
      .map((e) => {
        switch (e.type) {
          case 'user_message':
            return `[User]: ${e.content}`;
          case 'thinking':
            return `[Thinking]: ${e.content.slice(0, 500)}`;
          case 'tool_call':
            return `[Tool]: ${e.content}`;
          case 'assistant_reply':
            return `[Agent]: ${e.content}`;
          default:
            return `[${e.type}]: ${e.content}`;
        }
      })
      .join('\n');

    // Check for user messages that arrived after the timer was started (before clearing).
    // Uses event count to avoid same-millisecond timestamp edge cases.
    const hasNewUserMessages = buffer.events
      .slice(buffer.timerStartEventCount)
      .some((e) => e.type === 'user_message');

    // Clear events and timer before the async work
    buffer.events = [];
    buffer.timer = null;

    try {
      const summary = await oneShotComplete(this.modelRegistry, this.narratorModel, {
        systemPrompt: `Summarize this interaction between the user and a ${buffer.agentRole} agent for the Guide agent. Be concise. Focus on instructions the user gave, decisions made, and actions taken.`,
        userMessage: formattedLog,
      });

      // Deliver summary to Guide
      this.guideHost
        .deliverMessage(`[Conversation: user <-> ${buffer.agentRole}_${agentId}]\n\n${summary}`, {
          sender: agentId,
          receiver: this.guideAgentId,
          timestamp: Date.now(),
        })
        .catch((err) => log.error('[ConversationSummarizer] delivery failed:', err));
    } catch (err) {
      log.error('[ConversationSummarizer] Failed to generate summary:', err);
    }

    // Start new timer only if: additional messages existed in the window AND no timer was
    // already started by a concurrent recordUserMessage call during the await above.
    if (hasNewUserMessages && buffer.timer === null) {
      buffer.timerStartEventCount = buffer.events.length;
      buffer.timer = setTimeout(
        () => this.onTimerExpiry(agentId),
        ConversationSummarizer.TIMER_DURATION_MS
      );
    }
  }

  /** Clean up all timers and buffers. */
  cleanup(): void {
    for (const buffer of this.buffers.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
    }
    this.buffers.clear();
  }
}
