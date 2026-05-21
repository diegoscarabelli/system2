/**
 * WebSocketHandler tests focused on the agent_busy_state delivery contract.
 *
 * The chat input ("X% used") and the agent table ("Context %" column) both read
 * the same push-store entry now. That requires the server to send agent_busy_state
 * at three moments:
 *   1. Initial connect — snapshot for the Guide.
 *   2. switch_agent — snapshot for the newly focused agent.
 *   3. Busy transitions — broadcast (lives in Server.buildAgentCallbacks, not here).
 *
 * The agent_end event must NOT carry a separate context_usage payload anymore
 * (handled via the onBusyChange broadcast instead). These tests pin those
 * contracts so a future regression won't quietly re-introduce the dual source
 * of truth that caused the original AgentPane vs MessageInput drift.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../shared/index.js';
import type { AgentHost } from '../agents/host.js';
import type { AgentRegistry } from '../agents/registry.js';
import { WebSocketHandler } from './handler.js';

// Minimal stand-in for an AgentHost — only the methods WebSocketHandler reaches for.
function makeMockHost(opts: {
  busy?: boolean;
  contextPercent?: number | null;
  provider?: string;
  role?: string;
}): AgentHost & {
  __subscribers: Array<(event: unknown) => void>;
  __cacheSubscribers: Array<(message: unknown) => void>;
  __setBusy: (b: boolean) => void;
  __setContext: (p: number | null) => void;
} {
  let busy = opts.busy ?? false;
  let contextPercent: number | null = opts.contextPercent ?? null;
  const subscribers: Array<(event: unknown) => void> = [];
  const cacheSubscribers: Array<(message: unknown) => void> = [];

  const host = {
    role: opts.role ?? 'guide',
    chatCache: {
      getMessages: () => [],
      push: vi.fn(),
      subscribe: (cb: (message: unknown) => void) => {
        cacheSubscribers.push(cb);
        return () => {
          const i = cacheSubscribers.indexOf(cb);
          if (i >= 0) cacheSubscribers.splice(i, 1);
        };
      },
    },
    getProvider: () => opts.provider ?? 'anthropic',
    isBusy: () => busy,
    getContextUsage: () =>
      contextPercent === null
        ? undefined
        : { percent: contextPercent, tokens: 0, contextWindow: 0 },
    subscribe: (cb: (event: unknown) => void) => {
      subscribers.push(cb);
      return () => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    prompt: vi.fn(),
    abort: vi.fn(),
    state: { stopReason: 'end_turn' },
    flushPartialTurn: vi.fn(),
    __subscribers: subscribers,
    __cacheSubscribers: cacheSubscribers,
    __setBusy: (b: boolean) => {
      busy = b;
    },
    __setContext: (p: number | null) => {
      contextPercent = p;
    },
  };

  return host as unknown as AgentHost & {
    __subscribers: Array<(event: unknown) => void>;
    __cacheSubscribers: Array<(message: unknown) => void>;
    __setBusy: (b: boolean) => void;
    __setContext: (p: number | null) => void;
  };
}

interface MockWs {
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  OPEN: number;
  __listeners: Record<string, (data: Buffer) => void>;
}

function makeMockWs(): MockWs {
  const listeners: Record<string, (data: Buffer) => void> = {};
  return {
    send: vi.fn(),
    on: vi.fn((event: string, cb: (data: Buffer) => void) => {
      listeners[event] = cb;
    }),
    close: vi.fn(),
    readyState: 1,
    OPEN: 1,
    __listeners: listeners,
  };
}

function sentMessages(ws: MockWs): ServerMessage[] {
  return ws.send.mock.calls.map((call) => JSON.parse(call[0] as string) as ServerMessage);
}

describe('WebSocketHandler agent_busy_state delivery', () => {
  let guideHost: ReturnType<typeof makeMockHost>;
  let conductorHost: ReturnType<typeof makeMockHost>;
  let registry: AgentRegistry;
  let ws: MockWs;

  beforeEach(() => {
    guideHost = makeMockHost({
      busy: false,
      contextPercent: 42,
      provider: 'anthropic',
      role: 'guide',
    });
    conductorHost = makeMockHost({
      busy: true,
      contextPercent: 59,
      provider: 'openai-codex',
      role: 'conductor',
    });
    const hosts = new Map<number, AgentHost>([
      [1, guideHost as unknown as AgentHost],
      [5, conductorHost as unknown as AgentHost],
    ]);
    registry = { get: (id: number) => hosts.get(id) } as unknown as AgentRegistry;
    ws = makeMockWs();
  });

  it('sends Guide agent_busy_state snapshot on connect', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    const msgs = sentMessages(ws);
    const snapshot = msgs.find((m) => m.type === 'agent_busy_state');
    expect(snapshot).toEqual({
      type: 'agent_busy_state',
      agentId: 1,
      busy: false,
      contextPercent: 42,
    });
  });

  it('uses null contextPercent when getContextUsage returns undefined', () => {
    guideHost.__setContext(null);
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    const snapshot = sentMessages(ws).find((m) => m.type === 'agent_busy_state');
    expect(snapshot).toMatchObject({ agentId: 1, busy: false, contextPercent: null });
  });

  it('sends agent_busy_state snapshot for the new agent on switch_agent', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    // Reset to ignore constructor-time sends; only inspect what switch_agent emits.
    ws.send.mockClear();
    ws.__listeners.message?.(Buffer.from(JSON.stringify({ type: 'switch_agent', agentId: 5 })));

    const msgs = sentMessages(ws);
    const snapshot = msgs.find((m) => m.type === 'agent_busy_state');
    expect(snapshot).toEqual({
      type: 'agent_busy_state',
      agentId: 5,
      busy: true,
      contextPercent: 59,
    });

    // Switch sequence: chat_history, provider_info, agent_busy_state. ready_for_input
    // is skipped because the conductor is busy.
    const types = msgs.map((m) => m.type);
    expect(types).toContain('chat_history');
    expect(types).toContain('provider_info');
    expect(types).toContain('agent_busy_state');
    expect(types).not.toContain('ready_for_input');
  });

  it('agent_end emits only ready_for_input — no separate context_usage', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    ws.send.mockClear();
    // The handler subscribed to the Guide during construction — fire agent_end.
    guideHost.__subscribers[0]({ type: 'agent_end' });

    const types = sentMessages(ws).map((m) => m.type);
    expect(types).toContain('ready_for_input');
    // context_usage was the old dual-source-of-truth path; it must stay deleted.
    expect(types).not.toContain('context_usage');
    // agent_busy_state on agent_end is delivered via the AgentHost.onBusyChange
    // broadcast (Server-level), not from this handler, so it shouldn't appear here.
    expect(types).not.toContain('agent_busy_state');
  });

  it('switch_agent for missing agent sends an error and no snapshot', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    ws.send.mockClear();
    ws.__listeners.message?.(Buffer.from(JSON.stringify({ type: 'switch_agent', agentId: 999 })));

    const msgs = sentMessages(ws);
    expect(msgs.find((m) => m.type === 'error')).toBeTruthy();
    expect(msgs.find((m) => m.type === 'agent_busy_state')).toBeUndefined();
  });
});

describe('WebSocketHandler chat_message_added forwarding', () => {
  let guideHost: ReturnType<typeof makeMockHost>;
  let conductorHost: ReturnType<typeof makeMockHost>;
  let registry: AgentRegistry;
  let ws: MockWs;

  beforeEach(() => {
    guideHost = makeMockHost({ role: 'guide' });
    conductorHost = makeMockHost({ role: 'conductor' });
    const hosts = new Map<number, AgentHost>([
      [1, guideHost as unknown as AgentHost],
      [5, conductorHost as unknown as AgentHost],
    ]);
    registry = { get: (id: number) => hosts.get(id) } as unknown as AgentRegistry;
    ws = makeMockWs();
  });

  it('forwards a chatCache push as chat_message_added for the source agent', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );
    ws.send.mockClear();

    const message = {
      id: 'sys-1',
      role: 'system' as const,
      content:
        '401 auth error, switched to google\n\non anthropic, switching to google\n\n401 {}\n\nRun `system2 config` to refresh anthropic authentication and restart the server.',
      timestamp: 100,
    };
    // Simulate a server-side push into the guide's chatCache.
    for (const cb of guideHost.__cacheSubscribers) cb(message);

    const sent = sentMessages(ws).filter((m) => m.type === 'chat_message_added');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'chat_message_added', message, agentId: 1 });
  });

  it('forwards pushes for the second agent only after switch_agent subscribes to it', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    // Before subscribe: a push to the conductor must NOT reach this client.
    for (const cb of conductorHost.__cacheSubscribers) {
      cb({ id: 'a', role: 'system', content: 'noise', timestamp: 1 });
    }
    expect(sentMessages(ws).some((m) => m.type === 'chat_message_added')).toBe(false);

    // Switch (subscribes to conductor's chatCache), then push: it should arrive.
    ws.__listeners.message?.(Buffer.from(JSON.stringify({ type: 'switch_agent', agentId: 5 })));
    ws.send.mockClear();

    const message = {
      id: 'b',
      role: 'assistant' as const,
      content: 'hello',
      timestamp: 2,
    };
    for (const cb of conductorHost.__cacheSubscribers) cb(message);

    const sent = sentMessages(ws).filter((m) => m.type === 'chat_message_added');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'chat_message_added', message, agentId: 5 });
  });

  it('reuses the client-provided id when echoing a user_message via chat_message_added', () => {
    // Two clients on the same agent — when client A sends with id "client-id-1",
    // client B should receive a chat_message_added with the same id so its
    // dedup-by-id works against any local optimistic insert.
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );
    ws.send.mockClear();

    ws.__listeners.message?.(
      Buffer.from(
        JSON.stringify({
          type: 'user_message',
          content: 'hi',
          agentId: 1,
          id: 'client-id-1',
        })
      )
    );

    const pushed = (guideHost.chatCache.push as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushed).toMatchObject({ id: 'client-id-1', role: 'user', content: 'hi' });
  });

  it('replaces invalid client-provided ids with a server-generated UUID', () => {
    // A buggy/malicious client could send a multi-megabyte id, control chars,
    // or deliberately collide ids to trigger silent drops via dedup-by-id.
    // Validation: <=128 chars, charset [A-Za-z0-9_-].
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    const cases: Array<{ label: string; id: unknown }> = [
      { label: 'empty string', id: '' },
      { label: 'too long', id: 'x'.repeat(200) },
      { label: 'control char', id: 'msg-\n-evil' },
      { label: 'unicode', id: 'msg-évil' },
      { label: 'non-string', id: 12345 },
    ];

    for (const { id } of cases) {
      (guideHost.chatCache.push as ReturnType<typeof vi.fn>).mockClear();
      ws.__listeners.message?.(
        Buffer.from(JSON.stringify({ type: 'user_message', content: 'hi', agentId: 1, id }))
      );
      const pushed = (guideHost.chatCache.push as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(pushed.id).not.toBe(id);
      expect(pushed.id).toMatch(/^msg-[0-9a-f-]{36}$/);
    }
  });

  it('provider_change carries no reason (chat row arrives via chat_message_added)', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );
    ws.send.mockClear();

    // Synthetic status event from reinitializeWithProvider.
    guideHost.__subscribers[0]({
      type: 'status',
      provider: 'google',
      reason: 'should-be-stripped',
    });

    const sent = sentMessages(ws).find((m) => m.type === 'provider_change');
    expect(sent).toEqual({ type: 'provider_change', provider: 'google', agentId: 1 });
    expect((sent as Record<string, unknown> | undefined)?.reason).toBeUndefined();
  });

  it('cleans up the chatCache subscription on disconnect', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );
    expect(guideHost.__cacheSubscribers).toHaveLength(1);

    ws.__listeners.close?.(Buffer.alloc(0));
    expect(guideHost.__cacheSubscribers).toHaveLength(0);
  });

  it('steering_message flushes the in-flight partial BEFORE pushing the user row', () => {
    // Preserves chronological order in chatCache: assistant_partial then
    // user_steering. Without the flush, the user row gets pushed first and
    // the SDK's eventual message_end pushes the partial after, giving the
    // reverse (wrong) order on persisted history.
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );

    const callOrder: string[] = [];
    (guideHost.flushPartialTurn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('flushPartialTurn');
    });
    (guideHost.chatCache.push as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('chatCache.push');
    });

    ws.__listeners.message?.(
      Buffer.from(
        JSON.stringify({
          type: 'steering_message',
          content: 'change direction',
          agentId: 1,
          id: 'steer-1',
        })
      )
    );

    expect(callOrder).toEqual(['flushPartialTurn', 'chatCache.push']);
  });

  it('user_message does NOT flush partial (no in-flight turn to commit)', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1
    );
    (guideHost.flushPartialTurn as ReturnType<typeof vi.fn>).mockClear();

    ws.__listeners.message?.(
      Buffer.from(
        JSON.stringify({
          type: 'user_message',
          content: 'hi',
          agentId: 1,
          id: 'u-1',
        })
      )
    );

    expect(guideHost.flushPartialTurn).not.toHaveBeenCalled();
  });
});
