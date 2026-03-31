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

function messageEnd(): AgentSessionEvent {
  return { type: 'message_end' } as unknown as AgentSessionEvent;
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
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

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
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

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
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

    sub(messageEnd());

    expect(cache.push).not.toHaveBeenCalled();
  });

  it('captures compaction_start as system message', () => {
    const cache = mockCache();
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

    sub({ type: 'compaction_start' } as unknown as AgentSessionEvent);

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('Context compaction started');
  });

  it('captures compaction_end as system message', () => {
    const cache = mockCache();
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

    sub({ type: 'compaction_end' } as unknown as AgentSessionEvent);

    expect(cache.push).toHaveBeenCalledOnce();
    const msg = cache.messages[0] as { role: string; content: string };
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('Context compacted');
  });

  it('captures text + tool calls in the same turn', () => {
    const cache = mockCache();
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

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
    const sub = createHistoryCaptureSubscriber(() => cache as unknown as MessageHistory);

    sub(toolStart('bash', 'bad-cmd'));
    sub(toolEnd('bash', 'command not found', true));
    sub(messageEnd());

    const msg = cache.messages[0] as {
      turnEvents: Array<{ data: { result: string } }>;
    };
    expect(msg.turnEvents[0].data.result).toBe('Error: command not found');
  });
});
