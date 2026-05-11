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
  __setBusy: (b: boolean) => void;
  __setContext: (p: number | null) => void;
} {
  let busy = opts.busy ?? false;
  let contextPercent: number | null = opts.contextPercent ?? null;
  const subscribers: Array<(event: unknown) => void> = [];

  const host = {
    role: opts.role ?? 'guide',
    chatCache: { getMessages: () => [], push: vi.fn() },
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
    __subscribers: subscribers,
    __setBusy: (b: boolean) => {
      busy = b;
    },
    __setContext: (p: number | null) => {
      contextPercent = p;
    },
  };

  return host as unknown as AgentHost & {
    __subscribers: Array<(event: unknown) => void>;
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

function makeMockWss() {
  return { clients: new Set<MockWs>() };
}

function sentMessages(ws: MockWs): ServerMessage[] {
  return ws.send.mock.calls.map((call) => JSON.parse(call[0] as string) as ServerMessage);
}

describe('WebSocketHandler agent_busy_state delivery', () => {
  let guideHost: ReturnType<typeof makeMockHost>;
  let conductorHost: ReturnType<typeof makeMockHost>;
  let registry: AgentRegistry;
  let ws: MockWs;
  let wss: ReturnType<typeof makeMockWss>;

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
    wss = makeMockWss();
  });

  it('sends Guide agent_busy_state snapshot on connect', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1,
      wss as unknown as ConstructorParameters<typeof WebSocketHandler>[3]
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
      1,
      wss as unknown as ConstructorParameters<typeof WebSocketHandler>[3]
    );

    const snapshot = sentMessages(ws).find((m) => m.type === 'agent_busy_state');
    expect(snapshot).toMatchObject({ agentId: 1, busy: false, contextPercent: null });
  });

  it('sends agent_busy_state snapshot for the new agent on switch_agent', () => {
    new WebSocketHandler(
      ws as unknown as ConstructorParameters<typeof WebSocketHandler>[0],
      registry,
      1,
      wss as unknown as ConstructorParameters<typeof WebSocketHandler>[3]
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
      1,
      wss as unknown as ConstructorParameters<typeof WebSocketHandler>[3]
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
      1,
      wss as unknown as ConstructorParameters<typeof WebSocketHandler>[3]
    );

    ws.send.mockClear();
    ws.__listeners.message?.(Buffer.from(JSON.stringify({ type: 'switch_agent', agentId: 999 })));

    const msgs = sentMessages(ws);
    expect(msgs.find((m) => m.type === 'error')).toBeTruthy();
    expect(msgs.find((m) => m.type === 'agent_busy_state')).toBeUndefined();
  });
});
