import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { MessageHistory } from './history.js';
import { createHistoryCaptureSubscriber } from './history-capture.js';

interface MockCache {
  messages: unknown[];
  push: ReturnType<typeof vi.fn>;
}

function mockCache(): MockCache {
  const messages: unknown[] = [];
  const push = vi.fn((msg: unknown) => messages.push(msg));
  return { messages, push };
}

function textDelta(delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
  } as unknown as AgentSessionEvent;
}

function thinkingDelta(delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta },
  } as unknown as AgentSessionEvent;
}

function messageEnd(opts?: { stopReason?: string; errorMessage?: string }): AgentSessionEvent {
  const message = opts
    ? { stopReason: opts.stopReason, errorMessage: opts.errorMessage }
    : undefined;
  return { type: 'message_end', message } as unknown as AgentSessionEvent;
}

function toolStart(toolName: string, args?: unknown): AgentSessionEvent {
  return { type: 'tool_execution_start', toolName, args } as unknown as AgentSessionEvent;
}

function toolEnd(toolName: string, result?: string, isError = false): AgentSessionEvent {
  return {
    type: 'tool_execution_end',
    toolName,
    isError,
    result: result ? { content: [{ type: 'text', text: result }] } : undefined,
  } as unknown as AgentSessionEvent;
}

describe('createHistoryCaptureSubscriber', () => {
  it('captures text-only assistant turn', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub(textDelta('Hello '));
    sub(textDelta('world'));
    sub(messageEnd());

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as { role: string; content: string; turnEvents?: unknown };
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello world');
    expect(msg.turnEvents).toBeUndefined();
  });

  it('captures tool-only turn (no text)', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub(thinkingDelta('Let me think...'));
    sub(toolStart('read_file', { path: '/tmp/foo' }));
    sub(toolEnd('read_file', 'file contents'));
    sub(messageEnd());

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as {
      role: string;
      content: string;
      turnEvents: Array<{ type: string }>;
    };
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('');
    expect(msg.turnEvents).toHaveLength(2);
    expect(msg.turnEvents[0].type).toBe('thinking');
    expect(msg.turnEvents[1].type).toBe('tool_call');
  });

  it('does not push when message_end fires with no content or events', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub(messageEnd());

    expect(cache.push).not.toHaveBeenCalled();
  });

  it('captures compaction_start as a clean system message', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub({ type: 'compaction_start', reason: 'threshold' } as unknown as AgentSessionEvent);

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('Context compaction started');
  });

  it('captures successful compaction_end as a clean system message', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub({
      type: 'compaction_end',
      reason: 'threshold',
      result: { firstKeptEntryId: 'abc', tokensBefore: 100000 },
      aborted: false,
      willRetry: false,
    } as unknown as AgentSessionEvent);

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('Context compacted');
  });

  it('surfaces errorMessage on failed compaction_end', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'Auto-compaction failed: HTTP 400 max_tokens exceeds cap',
    } as unknown as AgentSessionEvent);

    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.content).toBe(
      'Context compaction failed: Auto-compaction failed: HTTP 400 max_tokens exceeds cap'
    );
  });

  it('surfaces aborted compaction_end distinctly from failure', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub({
      type: 'compaction_end',
      reason: 'manual',
      result: undefined,
      aborted: true,
      willRetry: false,
    } as unknown as AgentSessionEvent);

    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.content).toBe('Context compaction aborted');
  });

  it('surfaces silent no-op (result undefined, no flags) as a failure', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
    } as unknown as AgentSessionEvent);

    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.content).toContain('Context compaction failed');
    expect(msg.content).toContain('silent no-op');
  });

  it('captures text + tool calls in the same turn', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub(thinkingDelta('Thinking...'));
    sub(toolStart('bash', 'ls'));
    sub(toolEnd('bash', 'file.txt'));
    sub(textDelta('Here are the files.'));
    sub(messageEnd());

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as {
      role: string;
      content: string;
      turnEvents: Array<{ type: string; data: { status?: string; result?: string } }>;
    };
    expect(msg.content).toBe('Here are the files.');
    expect(msg.turnEvents).toHaveLength(2);
    expect(msg.turnEvents[0].type).toBe('thinking');
    expect(msg.turnEvents[1].type).toBe('tool_call');
    expect(msg.turnEvents[1].data.status).toBe('completed');
    expect(msg.turnEvents[1].data.result).toBe('file.txt');
  });

  it('marks tool error results with Error prefix', () => {
    const cache = mockCache();
    const { subscriber: sub } = createHistoryCaptureSubscriber(
      () => cache as unknown as MessageHistory
    );

    sub(toolStart('bash', 'bad-cmd'));
    sub(toolEnd('bash', 'command not found', true));
    sub(messageEnd());

    const msg = cache.messages[0] as {
      turnEvents: Array<{ data: { result: string } }>;
    };
    expect(msg.turnEvents[0].data.result).toBe('Error: command not found');
  });

  describe('error turns', () => {
    it('captures the partial assistant AND an LLM-error system row on stopReason=error', () => {
      const cache = mockCache();
      const { subscriber: sub } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(textDelta('I was almost done'));
      sub(
        messageEnd({ stopReason: 'error', errorMessage: '401 Invalid authentication credentials' })
      );

      // Two pushes: assistant partial first (chronological), then system error row.
      expect(cache.push).toHaveBeenCalledTimes(2);
      const assistant = cache.messages[0] as { role: string; content: string };
      const system = cache.messages[1] as { role: string; content: string };
      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toBe('I was almost done');
      expect(system.role).toBe('system');
      expect(system.content).toBe('LLM error\n\n401 Invalid authentication credentials');
    });

    it('still pushes the LLM-error row when the partial is empty', () => {
      const cache = mockCache();
      const { subscriber: sub } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(messageEnd({ stopReason: 'error', errorMessage: '503 service unavailable' }));

      expect(cache.push).toHaveBeenCalledOnce();
      const system = cache.messages[0] as { role: string; content: string };
      expect(system.role).toBe('system');
      expect(system.content).toBe('LLM error\n\n503 service unavailable');
    });

    it('does not push an LLM-error row when stopReason is not error', () => {
      const cache = mockCache();
      const { subscriber: sub } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(textDelta('done'));
      sub(messageEnd({ stopReason: 'end_turn' }));

      expect(cache.push).toHaveBeenCalledOnce();
      const msg = cache.messages[0] as { role: string };
      expect(msg.role).toBe('assistant');
    });
  });

  describe('flushPartial (steering ordering fix)', () => {
    it('commits the in-flight partial as an assistant message, then resets state', () => {
      const cache = mockCache();
      const { subscriber: sub, flushPartial } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(textDelta('half-finished response'));
      flushPartial();

      expect(cache.push).toHaveBeenCalledOnce();
      const msg = cache.messages[0] as { role: string; content: string };
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('half-finished response');

      // A subsequent message_end for the interrupted turn must NOT double-push:
      // the accumulator was reset by flushPartial.
      sub(messageEnd());
      expect(cache.push).toHaveBeenCalledOnce();
    });

    it('flushes accumulated thinking + tool calls as turn events', () => {
      const cache = mockCache();
      const { subscriber: sub, flushPartial } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(thinkingDelta('analyzing...'));
      sub(toolStart('read_file', { path: '/tmp/foo' }));
      sub(toolEnd('read_file', 'contents'));
      sub(textDelta('here is my response so far'));
      flushPartial();

      const msg = cache.messages[0] as {
        role: string;
        content: string;
        turnEvents: Array<{ type: string }>;
      };
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('here is my response so far');
      expect(msg.turnEvents).toHaveLength(2);
      expect(msg.turnEvents[0].type).toBe('thinking');
      expect(msg.turnEvents[1].type).toBe('tool_call');
    });

    it('is a no-op when nothing is in flight', () => {
      const cache = mockCache();
      const { flushPartial } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      flushPartial();
      expect(cache.push).not.toHaveBeenCalled();
    });

    it('records tool_execution_end as a follow-up row when the tool was flushed mid-run', () => {
      // Steering during tool use: flushPartial pushes the assistant message
      // with the tool_call still in 'running' state. When tool_execution_end
      // fires later, history-capture must push a follow-up assistant row so
      // the result isn't dropped.
      const cache = mockCache();
      const { subscriber: sub, flushPartial } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(toolStart('bash', 'ls'));
      flushPartial();
      // First push: assistant row with tool_call still 'running'.
      expect(cache.push).toHaveBeenCalledOnce();
      const flushedMsg = cache.messages[0] as {
        role: string;
        turnEvents: Array<{ data: { status: string } }>;
      };
      expect(flushedMsg.role).toBe('assistant');
      expect(flushedMsg.turnEvents[0].data.status).toBe('running');

      // Tool completes after the flush — follow-up row carries the result.
      sub(toolEnd('bash', 'a.txt b.txt'));
      expect(cache.push).toHaveBeenCalledTimes(2);
      const followup = cache.messages[1] as {
        role: string;
        content: string;
        turnEvents: Array<{
          type: string;
          data: { status: string; result: string; input: string };
        }>;
      };
      expect(followup.role).toBe('assistant');
      expect(followup.content).toBe('');
      expect(followup.turnEvents).toHaveLength(1);
      expect(followup.turnEvents[0].type).toBe('tool_call');
      expect(followup.turnEvents[0].data.status).toBe('completed');
      expect(followup.turnEvents[0].data.result).toBe('a.txt b.txt');
      expect(followup.turnEvents[0].data.input).toBe('ls');
    });

    it('matches multiple concurrent flushed tools in FIFO order by name', () => {
      const cache = mockCache();
      const { subscriber: sub, flushPartial } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(toolStart('bash', 'ls'));
      sub(toolStart('bash', 'pwd'));
      flushPartial();
      expect(cache.push).toHaveBeenCalledOnce();

      sub(toolEnd('bash', 'a.txt'));
      sub(toolEnd('bash', '/home'));

      expect(cache.push).toHaveBeenCalledTimes(3);
      const first = cache.messages[1] as {
        turnEvents: Array<{ data: { input: string; result: string } }>;
      };
      const second = cache.messages[2] as {
        turnEvents: Array<{ data: { input: string; result: string } }>;
      };
      // FIFO: first ls→a.txt, then pwd→/home.
      expect(first.turnEvents[0].data.input).toBe('ls');
      expect(first.turnEvents[0].data.result).toBe('a.txt');
      expect(second.turnEvents[0].data.input).toBe('pwd');
      expect(second.turnEvents[0].data.result).toBe('/home');
    });

    it('does NOT push a follow-up row when the tool completion matches the current in-flight turn', () => {
      // Normal flow (no flush): tool_execution_end updates currentTurnEvents
      // in place, message_end commits the whole turn. No follow-up.
      const cache = mockCache();
      const { subscriber: sub } = createHistoryCaptureSubscriber(
        () => cache as unknown as MessageHistory
      );

      sub(toolStart('bash', 'ls'));
      sub(toolEnd('bash', 'a.txt'));
      sub(messageEnd());

      expect(cache.push).toHaveBeenCalledOnce();
      const msg = cache.messages[0] as {
        turnEvents: Array<{ data: { status: string; result: string } }>;
      };
      expect(msg.turnEvents[0].data.status).toBe('completed');
      expect(msg.turnEvents[0].data.result).toBe('a.txt');
    });
  });
});
