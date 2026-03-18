/**
 * ConversationSummarizer Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/oneshot.js', () => ({
  oneShotComplete: vi.fn().mockResolvedValue('mocked summary'),
}));

import type { Api, Model } from '@mariozechner/pi-ai';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { AgentHost } from '../agents/host.js';
import { oneShotComplete } from '../llm/oneshot.js';
import { ConversationSummarizer } from './summarizer.js';

function makeGuideHost() {
  return { deliverMessage: vi.fn() } as unknown as AgentHost;
}

function makeSummarizer(guideAgentId = 1) {
  const guideHost = makeGuideHost();
  const summarizer = new ConversationSummarizer(
    guideHost,
    guideAgentId,
    {} as unknown as ModelRegistry,
    {} as unknown as Model<Api>
  );
  return { summarizer, guideHost };
}

describe('ConversationSummarizer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordUserMessage', () => {
    it('starts timer on first message', () => {
      const { summarizer } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordUserMessage(2, 'conductor', 'hello');

      expect(setTimeoutSpy).toHaveBeenCalledOnce();
      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        ConversationSummarizer.TIMER_DURATION_MS
      );
    });

    it('does not reset timer on subsequent calls within the same window', () => {
      const { summarizer } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordUserMessage(2, 'conductor', 'first');
      summarizer.recordUserMessage(2, 'conductor', 'second');
      summarizer.recordUserMessage(2, 'conductor', 'third');

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    });

    it('starts independent timers for different agents', () => {
      const { summarizer } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordUserMessage(2, 'conductor', 'to conductor');
      summarizer.recordUserMessage(3, 'reviewer', 'to reviewer');

      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('recordAgentEvent', () => {
    it('is a no-op when no buffer exists for the agent', () => {
      const { summarizer } = makeSummarizer();

      expect(() =>
        summarizer.recordAgentEvent(99, {
          type: 'assistant_reply',
          content: 'hi',
          timestamp: Date.now(),
        })
      ).not.toThrow();
    });

    it('does not start a timer when recording an event for a non-existent buffer', async () => {
      const { summarizer, guideHost } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordAgentEvent(99, { type: 'assistant_reply', content: 'hi', timestamp: 1 });

      await vi.runAllTimersAsync();

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(guideHost.deliverMessage).not.toHaveBeenCalled();
    });
  });

  describe('onTimerExpiry', () => {
    it('calls oneShotComplete and delivers summary to Guide', async () => {
      const { summarizer, guideHost } = makeSummarizer(1);

      summarizer.recordUserMessage(2, 'conductor', 'user question');

      await vi.runAllTimersAsync();

      expect(oneShotComplete).toHaveBeenCalledOnce();
      expect(guideHost.deliverMessage).toHaveBeenCalledOnce();
    });

    it('includes agent role and id in delivered summary', async () => {
      const { summarizer, guideHost } = makeSummarizer(1);

      summarizer.recordUserMessage(2, 'conductor', 'question');

      await vi.runAllTimersAsync();

      const [content, details] = (guideHost.deliverMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content).toContain('[Summary of user interaction with conductor agent (id=2)]');
      expect(content).toContain('mocked summary');
      expect(details.receiver).toBe(1);
      expect(details.sender).toBe(2);
    });

    it('formats user messages in the prompt', async () => {
      const { summarizer } = makeSummarizer(1);

      summarizer.recordUserMessage(2, 'conductor', 'do the thing');

      await vi.runAllTimersAsync();

      const [, , opts] = (oneShotComplete as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.userMessage).toContain('[User]: do the thing');
    });

    it('formats agent events in the prompt', async () => {
      const { summarizer } = makeSummarizer(1);

      summarizer.recordUserMessage(2, 'conductor', 'do the thing');
      summarizer.recordAgentEvent(2, {
        type: 'assistant_reply',
        content: 'done',
        timestamp: Date.now(),
      });
      summarizer.recordAgentEvent(2, { type: 'tool_call', content: 'bash', timestamp: Date.now() });

      await vi.runAllTimersAsync();

      const [, , opts] = (oneShotComplete as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.userMessage).toContain('[Agent]: done');
      expect(opts.userMessage).toContain('[Tool]: bash');
    });

    it('does NOT restart timer when only one user message in window', async () => {
      const { summarizer } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordUserMessage(2, 'conductor', 'only message');
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      await vi.runAllTimersAsync();

      // No second timer should have been started
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    });

    it('restarts timer when a second user message arrived during the window', async () => {
      const { summarizer } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordUserMessage(2, 'conductor', 'first message');
      // Advance time within the window (timer hasn't fired yet)
      vi.advanceTimersByTime(1000);
      // Second message arrives during the timer window (after the first)
      summarizer.recordUserMessage(2, 'conductor', 'second message');

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      // Expire the timer
      await vi.runAllTimersAsync();

      // New timer should have started for the second message
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    });

    it('clears events after timer fires', async () => {
      const { summarizer, guideHost } = makeSummarizer(1);

      summarizer.recordUserMessage(2, 'conductor', 'message');
      await vi.runAllTimersAsync();

      // First summary delivered
      expect(guideHost.deliverMessage).toHaveBeenCalledTimes(1);

      // Second timer fires (only if a new message created it — it shouldn't here)
      await vi.runAllTimersAsync();

      // No second delivery (no events buffered)
      expect(guideHost.deliverMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup', () => {
    it('clears all timers and prevents delivery', async () => {
      const { summarizer, guideHost } = makeSummarizer();

      summarizer.recordUserMessage(2, 'conductor', 'message');
      summarizer.cleanup();

      await vi.runAllTimersAsync();

      expect(oneShotComplete).not.toHaveBeenCalled();
      expect(guideHost.deliverMessage).not.toHaveBeenCalled();
    });

    it('recordUserMessage after cleanup starts a fresh buffer with a new timer', () => {
      const { summarizer } = makeSummarizer();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      summarizer.recordUserMessage(2, 'conductor', 'before cleanup');
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      summarizer.cleanup();

      summarizer.recordUserMessage(2, 'conductor', 'after cleanup');
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    });
  });
});
