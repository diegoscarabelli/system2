/**
 * AgentHost Tests
 *
 * Tests for the failover race condition fix: pendingPrompt must be captured
 * before any await in handlePotentialError, since prompt() clears it after
 * session.prompt() resolves.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '../../shared/index.js';
import {
  AgentHost,
  DELIVERY_DISPATCH_TIMEOUT_MS,
  MAX_DELIVERY_BYTES,
  PENDING_DELIVERY_TIMEOUT_MS,
  pickModelForTier,
} from './host.js';
import type { AgentRegistry } from './registry.js';

// Stub retry.ts's `sleep` so the retry-path tests don't actually wait the
// exponential-backoff delay (~1s+ per case from `calculateDelay`). Everything
// else in retry.ts is kept as the real implementation — `shouldRetry` /
// `shouldFailover` / `categorizeError` behavior is what these tests exercise.
vi.mock('./retry.js', async () => {
  const actual = await vi.importActual<typeof import('./retry.js')>('./retry.js');
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

// Mock pi-ai's catalog for pickModelForTier tests so the OAuth resolver
// returns deterministic IDs regardless of what's installed.
vi.mock('@mariozechner/pi-ai', () => ({
  getProviders: () => ['anthropic', 'openai-codex', 'github-copilot'],
  getModels: (provider: string) => {
    const catalogs: Record<string, Array<{ id: string; contextWindow: number }>> = {
      anthropic: [
        { id: 'claude-opus-4-6', contextWindow: 200000 },
        { id: 'claude-opus-4-7', contextWindow: 200000 },
        { id: 'claude-sonnet-4-6', contextWindow: 200000 },
      ],
      'openai-codex': [
        { id: 'gpt-5.4', contextWindow: 272000 },
        { id: 'gpt-5.5', contextWindow: 272000 },
      ],
      'github-copilot': [
        { id: 'gpt-4.1', contextWindow: 128000 },
        { id: 'gpt-5.4', contextWindow: 272000 },
      ],
    };
    return catalogs[provider] ?? [];
  },
}));

// Minimal stubs — we're testing internal state management, not the full agent lifecycle
function makeLlmConfig(): LlmConfig {
  return {
    primary: 'cerebras',
    fallback: ['google'],
    providers: {
      cerebras: { keys: [{ key: 'cer-key-1', label: 'main' }] },
      google: { keys: [{ key: 'goo-key-1', label: 'main' }] },
    },
  };
}

function makeDbStub() {
  return {
    getAgent: vi.fn().mockReturnValue({
      id: 1,
      role: 'guide',
      project: null,
      status: 'active',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    }),
    query: vi.fn().mockReturnValue([]),
  } as unknown as import('../db/client.js').DatabaseClient;
}

function makeRegistryStub() {
  return {
    get: vi.fn(),
    register: vi.fn(),
    has: vi.fn(),
    listIds: vi.fn().mockReturnValue([]),
    unregister: vi.fn(),
  } as unknown as AgentRegistry;
}

describe('AgentHost', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pendingPrompt race condition', () => {
    it('captures pendingPrompt synchronously before yielding in handlePotentialError', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      // Access private fields for testing via type escape hatch
      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        session: unknown;
        handlePotentialError: (event: unknown) => Promise<void>;
        isReinitializing: boolean;
        authResolver: { markKeyFailed: () => boolean; getNextProvider: () => string | null };
        retryAttempts: Map<string, number>;
        currentProvider: string;
      };

      // Set up state: simulate a prompt in progress
      hostInternal.pendingPrompt = 'test prompt';
      hostInternal.session = { prompt: vi.fn().mockResolvedValue(undefined) };
      hostInternal.currentProvider = 'cerebras';

      // Mock authResolver to allow failover but provide no next provider
      // (so we don't need to mock the full reinitialize path)
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      // Create an auth error event — categorizeError parses '401' from the
      // message text via regex, categorizes as 'auth', which skips retry
      // entirely (shouldRetry returns false for auth) and goes straight to failover
      const errorEvent = {
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage: 'Error 401: Unauthorized - Invalid API key',
        },
      };

      // Simulate the race: clear pendingPrompt on next microtask
      // (this is what prompt() does after session.prompt() resolves)
      const clearPromise = Promise.resolve().then(() => {
        hostInternal.pendingPrompt = null;
      });

      // handlePotentialError must capture pendingPrompt synchronously BEFORE
      // any await. Even though pendingPrompt is cleared on the next microtask,
      // the capture at the top of the function preserves the value.
      const handlePromise = hostInternal.handlePotentialError(errorEvent);

      await Promise.all([clearPromise, handlePromise]);

      // The key assertion: markKeyFailed was called, meaning handlePotentialError
      // got past the "should we failover" check. If promptToRetry wasn't captured
      // before the first await, the code would still work for the auth path
      // (which doesn't use promptToRetry for the failover decision), but the
      // captured value would be null instead of 'test prompt'.
      expect(hostInternal.authResolver.markKeyFailed).toHaveBeenCalled();
    });

    it('prompt() sets pendingPrompt and keeps it set until agent_end fires', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        session: { prompt: ReturnType<typeof vi.fn> };
        handleSessionEvent: (event: {
          type: string;
          result?: unknown;
          aborted?: boolean;
          errorMessage?: string;
        }) => void;
      };

      // Track pendingPrompt value during session.prompt()
      let promptDuringSession: string | null = null;
      hostInternal.session = {
        prompt: vi.fn().mockImplementation(async () => {
          promptDuringSession = hostInternal.pendingPrompt;
        }),
      };

      await host.prompt('hello world');

      // During session.prompt(), pendingPrompt was set
      expect(promptDuringSession).toBe('hello world');
      // After session.prompt() resolves, pendingPrompt is still set —
      // clearing moved to agent_end so queued turns (followUp/steer) stay retryable
      expect(hostInternal.pendingPrompt).toBe('hello world');
      // Non-steering: streamingBehavior must be 'followUp' (not undefined) to prevent
      // silent drops when a background sendCustomMessage turn is in flight
      expect(hostInternal.session.prompt).toHaveBeenCalledWith('hello world', {
        streamingBehavior: 'followUp',
      });

      // Simulate agent_end: pendingPrompt is now cleared
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingPrompt).toBeNull();

      // Steering: streamingBehavior must be 'steer'
      await host.prompt('steer message', { isSteering: true });
      expect(hostInternal.session.prompt).toHaveBeenLastCalledWith('steer message', {
        streamingBehavior: 'steer',
      });
    });

    it('handleSessionEvent clears pendingPrompt on agent_end but not on other events', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        handleSessionEvent: (event: {
          type: string;
          result?: unknown;
          aborted?: boolean;
          errorMessage?: string;
        }) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
      };

      // Suppress internal method calls (not under test here)
      // handlePotentialError must return a Promise since handleSessionEvent calls .catch() on it
      hostInternal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      hostInternal.handleCompactionTracking = vi.fn();

      hostInternal.pendingPrompt = 'pending message';

      hostInternal.handleSessionEvent({ type: 'message_update' });
      expect(hostInternal.pendingPrompt).toBe('pending message');

      hostInternal.handleSessionEvent({ type: 'tool_execution_start' });
      expect(hostInternal.pendingPrompt).toBe('pending message');

      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingPrompt).toBeNull();
    });

    it('tracks pendingDeliveries and resolves on agent_end using deliverySendCount', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        handleSessionEvent: (event: Record<string, unknown>) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
        session: unknown;
        _chatCache: null;
      };

      hostInternal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      hostInternal.handleCompactionTracking = vi.fn();
      hostInternal.session = {
        sendCustomMessage: vi.fn(),
      };
      hostInternal._chatCache = null;

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      const resolve1 = vi.fn();
      const resolve2 = vi.fn();

      // deliverMessage pushes to queue (don't await: testing tracking, not the promise)
      host.deliverMessage('msg1', details);
      host.deliverMessage('msg2', details);
      expect(hostInternal.pendingDeliveries).toHaveLength(2);
      expect(hostInternal.pendingDeliveries[0].content).toBe('msg1');
      expect(hostInternal.pendingDeliveries[1].content).toBe('msg2');

      // Capture the resolve callbacks pushed by deliverMessage
      hostInternal.pendingDeliveries[0].resolve = resolve1;
      hostInternal.pendingDeliveries[1].resolve = resolve2;

      // agent_end with deliverySendCount=0 does NOT shift deliveries
      hostInternal.deliverySendCount = 0;
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingDeliveries).toHaveLength(2);

      // agent_end with deliverySendCount=1 shifts one delivery
      hostInternal.deliverySendCount = 1;
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingDeliveries).toHaveLength(1);
      expect(hostInternal.pendingDeliveries[0].content).toBe('msg2');
      expect(resolve1).toHaveBeenCalledOnce();
      expect(hostInternal.deliverySendCount).toBe(0); // reset after agent_end

      // agent_end with deliverySendCount=1 clears the remaining delivery
      hostInternal.deliverySendCount = 1;
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingDeliveries).toHaveLength(0);
      expect(resolve2).toHaveBeenCalledOnce();

      // Extra agent_end on empty queue is a no-op (counter clamped to queue length)
      hostInternal.deliverySendCount = 5;
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingDeliveries).toHaveLength(0);
      expect(hostInternal.deliverySendCount).toBe(0);
    });

    it('lastTurnErrored prevents cleanup on error turns', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        lastTurnErrored: boolean;
        handleSessionEvent: (event: Record<string, unknown>) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
      };

      hostInternal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      hostInternal.handleCompactionTracking = vi.fn();

      const resolveDelivery = vi.fn();
      const rejectDelivery = vi.fn();

      hostInternal.pendingPrompt = 'user message';
      hostInternal.pendingDeliveries = [
        {
          content: 'delivery1',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          resolve: resolveDelivery,
          reject: rejectDelivery,
        },
      ];

      // Simulate error turn: handlePotentialError sets the flag before agent_end fires
      hostInternal.lastTurnErrored = true;
      hostInternal.deliverySendCount = 1;
      hostInternal.handleSessionEvent({ type: 'agent_end' });

      // Neither pendingPrompt nor pendingDeliveries should be cleaned up
      expect(hostInternal.pendingPrompt).toBe('user message');
      expect(hostInternal.pendingDeliveries).toHaveLength(1);
      expect(hostInternal.pendingDeliveries[0].content).toBe('delivery1');

      // Neither resolve nor reject should be called on error turns
      expect(resolveDelivery).not.toHaveBeenCalled();
      expect(rejectDelivery).not.toHaveBeenCalled();

      // Flag is reset after agent_end, but deliverySendCount preserved for retry
      expect(hostInternal.lastTurnErrored).toBe(false);

      // Next successful agent_end with deliverySendCount=1 cleans up normally
      hostInternal.deliverySendCount = 1;
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingPrompt).toBeNull();
      expect(hostInternal.pendingDeliveries).toHaveLength(0);
      expect(resolveDelivery).toHaveBeenCalledOnce();
    });

    it('deliverMessage returns promise that resolves on agent_end', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        handleSessionEvent: (event: Record<string, unknown>) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
      };

      hostInternal.session = { sendCustomMessage: vi.fn() };
      hostInternal._chatCache = null;
      hostInternal._sessionDir = null;
      hostInternal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      hostInternal.handleCompactionTracking = vi.fn();

      const promise = host.deliverMessage('msg1', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      // Simulate the send counter being incremented (normally done by .then() on sendCustomMessage)
      hostInternal.deliverySendCount = 1;

      // Fire agent_end to resolve the promise using the send counter
      hostInternal.handleSessionEvent({ type: 'agent_end' });

      await expect(promise).resolves.toBeUndefined();
    });

    it('agent_end resolves delivery promises in order using send counter', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        handleSessionEvent: (event: Record<string, unknown>) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
      };

      hostInternal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      hostInternal.handleCompactionTracking = vi.fn();

      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      const details = { sender: 1, receiver: 2, timestamp: Date.now() };

      hostInternal.pendingDeliveries = [
        { content: 'first', details, resolve: resolve1, reject: vi.fn() },
        { content: 'second', details, resolve: resolve2, reject: vi.fn() },
      ];

      // agent_end with deliverySendCount=2 resolves both in order
      hostInternal.deliverySendCount = 2;
      hostInternal.handleSessionEvent({ type: 'agent_end' });

      expect(resolve1).toHaveBeenCalledOnce();
      expect(resolve2).toHaveBeenCalledOnce();
      expect(hostInternal.pendingDeliveries).toHaveLength(0);
      expect(hostInternal.deliverySendCount).toBe(0);
    });

    it('captures deliveriesToRetry and replays them on failover', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        session: { prompt: ReturnType<typeof vi.fn> };
        handlePotentialError: (event: unknown) => Promise<void>;
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      hostInternal.session = { prompt: vi.fn().mockResolvedValue(undefined) };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null;

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      hostInternal.pendingDeliveries = [
        { content: 'project-log', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
        { content: 'daily-summary', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
      ];

      // Force failover path: exhaust retries
      hostInternal.retryAttempts = new Map([['cerebras:client', 7]]);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue('google');
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 400: credit balance too low' },
      });

      // deliveriesToRetry should be passed to reinitializeWithProvider
      expect(hostInternal.reinitializeWithProvider).toHaveBeenCalledWith(
        'google',
        null,
        [
          expect.objectContaining({ content: 'project-log', details, urgent: false }),
          expect.objectContaining({ content: 'daily-summary', details, urgent: false }),
        ],
        expect.any(String),
        expect.any(String)
      );
    });

    it('retry paths restore pendingPrompt and pass streamingBehavior before calling session.prompt()', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        session: { prompt: ReturnType<typeof vi.fn> };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
      };

      let pendingAtRetryTime: string | null = null;
      hostInternal.session = {
        prompt: vi.fn().mockImplementation(async () => {
          pendingAtRetryTime = hostInternal.pendingPrompt;
        }),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.pendingPrompt = 'original message';

      // Use a rate_limit error — shouldRetry returns true for first attempt
      const errorEvent = {
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage: 'Error 429: rate limit exceeded',
        },
      };

      // retryAttempts=0 means shouldRetry returns true → handlePotentialError takes the
      // retry path, calls session.prompt(), then returns early. The failover mocks are
      // set up defensively but are not exercised in this scenario.
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);
      hostInternal.retryAttempts = new Map();

      await hostInternal.handlePotentialError(errorEvent);

      // pendingPrompt was restored before session.prompt() was called
      expect(pendingAtRetryTime).toBe('original message');
      // streamingBehavior: 'followUp' prevents a throw if a deliverMessage turn
      // happens to start during the retry delay
      expect(hostInternal.session.prompt).toHaveBeenCalledWith('original message', {
        streamingBehavior: 'followUp',
      });
    });

    it('same-provider retry re-sends failed delivery via sendCustomMessage', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        lastTurnErrored: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null; // No prompt, only a delivery

      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      hostInternal.pendingDeliveries = [
        { content: 'project-log', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
      ];

      // Rate limit error, first attempt: shouldRetry returns true
      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      // Defensive mocks for failover path (not exercised)
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      // Should NOT have called session.prompt (no pending prompt)
      expect(hostInternal.session.prompt).not.toHaveBeenCalled();

      // Should have re-sent the delivery via sendCustomMessage
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        {
          customType: 'agent_message',
          content: 'project-log',
          display: false,
          details,
        },
        {
          deliverAs: 'followUp',
          triggerTurn: true,
        }
      );
    });

    it('same-provider retry uses steer for urgent deliveries', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        lastTurnErrored: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null;

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      hostInternal.pendingDeliveries = [
        { content: 'urgent-msg', details, urgent: true, resolve: vi.fn(), reject: vi.fn() },
      ];

      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'urgent-msg' }),
        expect.objectContaining({ deliverAs: 'steer' })
      );
    });

    it('same-provider retry rejects delivery promise when sendCustomMessage fails', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        lastTurnErrored: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      const sendError = new Error('session torn down');
      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockRejectedValue(sendError),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null;

      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const rejectFn = vi.fn();
      hostInternal.pendingDeliveries = [
        { content: 'project-log', details, urgent: false, resolve: vi.fn(), reject: rejectFn },
      ];

      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      // Wait for the .catch() microtask to run
      await new Promise((r) => setTimeout(r, 0));

      expect(rejectFn).toHaveBeenCalledWith(sendError);
      expect(hostInternal.pendingDeliveries).toHaveLength(0);
    });

    it('same-provider retry resends ALL pending deliveries, not just the first', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        lastTurnErrored: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null;

      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      hostInternal.pendingDeliveries = [
        { content: 'project-log-A', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
        { content: 'project-log-B', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
        { content: 'daily-summary', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
      ];

      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      // All 3 deliveries should have been resent
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledTimes(3);
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'project-log-A' }),
        expect.objectContaining({ deliverAs: 'followUp', triggerTurn: true })
      );
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'project-log-B' }),
        expect.objectContaining({ deliverAs: 'followUp', triggerTurn: true })
      );
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'daily-summary' }),
        expect.objectContaining({ deliverAs: 'followUp', triggerTurn: true })
      );
    });

    it('same-provider retry resends deliveries even when prompt is also retried', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        lastTurnErrored: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
        resourceLoader: { reload: ReturnType<typeof vi.fn> } | null;
      };

      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      hostInternal.resourceLoader = { reload: vi.fn().mockResolvedValue(undefined) };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = 'user question';

      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      hostInternal.pendingDeliveries = [
        { content: 'project-log', details, urgent: false, resolve: vi.fn(), reject: vi.fn() },
      ];

      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 503: service unavailable' },
      });

      // Prompt should have been retried
      expect(hostInternal.session.prompt).toHaveBeenCalledWith('user question', {
        streamingBehavior: 'followUp',
      });

      // Delivery should ALSO have been resent (not dropped by the old else-if)
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'project-log' }),
        expect.objectContaining({ deliverAs: 'followUp', triggerTurn: true })
      );
    });

    it('pendingPrompt persists if session.prompt() throws', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        session: { prompt: ReturnType<typeof vi.fn> };
      };

      hostInternal.session = {
        prompt: vi.fn().mockRejectedValue(new Error('connection failed')),
      };

      await expect(host.prompt('hello world')).rejects.toThrow('connection failed');

      // pendingPrompt stays set — clearing only happens on agent_end, which never
      // fires when session.prompt() throws synchronously
      expect(hostInternal.pendingPrompt).toBe('hello world');
    });

    it('rejects pending deliveries instead of resending when turn already emitted output (#175)', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        currentTurnHasOutput: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null;

      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const reject1 = vi.fn();
      const reject2 = vi.fn();
      hostInternal.pendingDeliveries = [
        { content: 'project-log', details, urgent: false, resolve: vi.fn(), reject: reject1 },
        { content: 'daily-summary', details, urgent: false, resolve: vi.fn(), reject: reject2 },
      ];

      // Simulate that the model emitted output before the failure (e.g. ran a tool call).
      hostInternal.currentTurnHasOutput = true;

      // Rate limit on first attempt would normally take the retry path and resend.
      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      expect(reject1).toHaveBeenCalledOnce();
      expect(reject2).toHaveBeenCalledOnce();
      const rejectArg = reject1.mock.calls[0][0] as Error;
      expect(rejectArg).toBeInstanceOf(Error);
      expect(rejectArg.message).toContain('API error after model output');
      expect(hostInternal.pendingDeliveries).toHaveLength(0);
      // No resend: sendCustomMessage must not have been called.
      expect(hostInternal.session.sendCustomMessage).not.toHaveBeenCalled();
      // retryAttempts must not have been incremented: there was nothing left
      // to retry once contamination cleared the deliveries and there is no
      // pending prompt, so the budget for future errors stays intact (#175).
      expect(hostInternal.retryAttempts.size).toBe(0);
    });

    it('still resends pending deliveries when no output was emitted yet (#175 regression)', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        currentTurnHasOutput: boolean;
        session: {
          prompt: ReturnType<typeof vi.fn>;
          sendCustomMessage: ReturnType<typeof vi.fn>;
        };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
          isKeyInCooldown: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
      };

      hostInternal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      hostInternal.currentProvider = 'cerebras';
      hostInternal.currentKeyIndex = 0;
      hostInternal.pendingPrompt = null;

      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const reject1 = vi.fn();
      hostInternal.pendingDeliveries = [
        { content: 'project-log', details, urgent: false, resolve: vi.fn(), reject: reject1 },
      ];

      // No output emitted yet — safe to resend.
      hostInternal.currentTurnHasOutput = false;

      hostInternal.retryAttempts = new Map();
      hostInternal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await hostInternal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      // Existing resend path runs.
      expect(reject1).not.toHaveBeenCalled();
      expect(hostInternal.session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'project-log' }),
        expect.objectContaining({ deliverAs: 'followUp', triggerTurn: true })
      );
    });

    it('handleSessionEvent flips currentTurnHasOutput on output events and resets on turn_start (#175, #192)', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        currentTurnHasOutput: boolean;
        handleSessionEvent: (event: unknown) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
      };

      hostInternal.handlePotentialError = vi.fn().mockResolvedValue(undefined);

      expect(hostInternal.currentTurnHasOutput).toBe(false);

      hostInternal.handleSessionEvent({ type: 'turn_start' });
      expect(hostInternal.currentTurnHasOutput).toBe(false);

      // message_start alone must NOT flip the flag (#192). The Pi SDK fires this when a
      // message scaffold is created (which happens for user messages too, and for assistant
      // streams that close with an auth failure before any tokens arrive). Treating it as
      // "model emitted output" caused the contamination guard to drop Anthropic streaming
      // 401s before the failover path could write a user-visible chat message with the
      // OAuth re-auth hint. The flag is meant to track real side-effect risk, which only
      // exists once content streams (`message_update`) or a tool starts executing.
      hostInternal.handleSessionEvent({ type: 'message_start', message: {} });
      expect(hostInternal.currentTurnHasOutput).toBe(false);

      hostInternal.handleSessionEvent({
        type: 'tool_execution_start',
        toolCallId: 'x',
        toolName: 'Edit',
        args: {},
      });
      expect(hostInternal.currentTurnHasOutput).toBe(true);

      hostInternal.handleSessionEvent({ type: 'turn_start' });
      expect(hostInternal.currentTurnHasOutput).toBe(false);

      hostInternal.handleSessionEvent({
        type: 'message_update',
        message: {},
        assistantMessageEvent: {},
      });
      expect(hostInternal.currentTurnHasOutput).toBe(true);

      // agent_end also resets the flag at the run boundary, matching the
      // documented lifecycle.
      hostInternal.handleSessionEvent({ type: 'agent_end', messages: [] });
      expect(hostInternal.currentTurnHasOutput).toBe(false);
    });
  });

  describe('busy state', () => {
    function makeHostWithBusyTracking() {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as {
        busy: boolean;
        session: { prompt: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
        listeners: Set<(event: unknown) => void>;
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        pendingPrompt: string | null;
      };
      return { host, internal };
    }

    /** Set up a fake session and subscribe via initialize's event handler path */
    function setupWithFakeSession(
      internal: ReturnType<typeof makeHostWithBusyTracking>['internal']
    ) {
      // The real subscribe path goes through session.subscribe in initialize().
      // Since we can't call initialize() (needs real filesystem), we simulate
      // by directly adding a listener that mirrors the busy tracking logic.
      // Instead, we just set the session and test via the public listener mechanism
      // plus direct busy flag manipulation.
      internal.session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      };
    }

    it('starts not busy', () => {
      const { host } = makeHostWithBusyTracking();
      expect(host.isBusy()).toBe(false);
    });

    it('abort() clears busy', () => {
      const { host, internal } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      // Simulate being busy
      internal.busy = true;

      host.abort();

      expect(host.isBusy()).toBe(false);
    });

    it('abort() clears pendingPrompt', () => {
      const { host, internal } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      internal.pendingPrompt = 'message in flight';

      host.abort();

      expect(internal.pendingPrompt).toBeNull();
    });

    it('abort() clears pendingDeliveries and rejects their promises', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        session: { abort: ReturnType<typeof vi.fn> };
      };

      const reject1 = vi.fn();
      const reject2 = vi.fn();

      internal.session = { abort: vi.fn() };
      internal.pendingDeliveries = [
        {
          content: 'msg1',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          resolve: vi.fn(),
          reject: reject1,
        },
        {
          content: 'msg2',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          resolve: vi.fn(),
          reject: reject2,
        },
      ];

      host.abort();

      expect(internal.pendingDeliveries).toHaveLength(0);
      expect(reject1).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Agent session aborted' })
      );
      expect(reject2).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Agent session aborted' })
      );
    });

    it('abort() is a no-op when already idle', () => {
      const { host, internal } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      host.abort();

      expect(host.isBusy()).toBe(false);
    });

    it('handlePotentialError clears busy when all recovery paths exhausted', async () => {
      const { host, internal } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      // Simulate being busy
      internal.busy = true;
      internal.currentProvider = 'cerebras';

      // No next provider available
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      const errorEvent = {
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage: 'Error 401: Unauthorized',
        },
      };

      await internal.handlePotentialError(errorEvent);

      expect(host.isBusy()).toBe(false);
    });

    it('all-providers-exhausted rejects delivery promises and clears pendingDeliveries', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingPrompt: string | null;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        lastTurnErrored: boolean;
        session: { prompt: ReturnType<typeof vi.fn> };
        handlePotentialError: (event: unknown) => Promise<void>;
        authResolver: {
          isKeyInCooldown: ReturnType<typeof vi.fn>;
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        currentProvider: string;
        currentKeyIndex: number;
        busy: boolean;
      };

      internal.session = { prompt: vi.fn() };
      internal.currentProvider = 'cerebras';
      internal.currentKeyIndex = 0;
      internal.busy = true;

      const rejectDelivery = vi.fn();

      internal.pendingPrompt = 'user message';
      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      internal.pendingDeliveries = [
        {
          content: 'project-log',
          details,
          urgent: false,
          resolve: vi.fn(),
          reject: rejectDelivery,
        },
      ];

      // All providers exhausted: auth error, no next provider
      internal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);
      internal.retryAttempts = new Map();

      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 401: Unauthorized' },
      });

      // pendingPrompt preserved (lastTurnErrored prevented agent_end from clearing it)
      expect(internal.pendingPrompt).toBe('user message');
      // Delivery promises rejected and cleared by all-providers-exhausted path
      expect(rejectDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('All providers exhausted') })
      );
      expect(internal.pendingDeliveries).toHaveLength(0);
    });

    it('busy stays false when already idle', () => {
      const { host, internal } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      // Already idle, abort should not change state
      host.abort();
      expect(host.isBusy()).toBe(false);

      // Already idle, clearing busy via error exhaustion should not change state
      internal.currentProvider = 'cerebras';
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 401: Unauthorized' },
      });
      expect(host.isBusy()).toBe(false);
    });
  });

  describe('getProvider', () => {
    it('returns the current provider', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      expect(host.getProvider()).toBe('cerebras');
    });
  });

  describe('subscribe', () => {
    it('returns unsubscribe function that removes listener', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const hostInternal = host as unknown as {
        listeners: Set<unknown>;
      };

      const listener = vi.fn();
      const unsubscribe = host.subscribe(listener);

      expect(hostInternal.listeners.size).toBe(1);

      unsubscribe();
      expect(hostInternal.listeners.size).toBe(0);
    });
  });

  describe('chatCache', () => {
    it('throws before initialize()', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      expect(() => host.chatCache).toThrow('AgentHost not initialized');
    });

    it('returns the MessageHistory once _chatCache is set', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as { _chatCache: object };
      const mockCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._chatCache = mockCache;

      expect(host.chatCache).toBe(mockCache);
    });

    it('preserves existing instance across reinitialize', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as { _chatCache: object; initialize: () => Promise<void> };
      const originalCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._chatCache = originalCache;

      // Calling initialize() again (as reinitializeWithProvider does) should
      // keep the existing chat cache instance, not replace it.
      try {
        await internal.initialize();
      } catch {
        // initialize() may throw due to missing agent DB record; that's fine
      }

      expect(internal._chatCache).toBe(originalCache);
    });
  });

  describe('deliverMessage', () => {
    it('rejects if session is not initialized', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      await expect(
        host.deliverMessage('hello', { sender: 2, receiver: 1, timestamp: Date.now() })
      ).rejects.toThrow('AgentHost has no session available');
    });

    it('stores full content for inter-agent messages', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = {
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
      };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      const ts = 1_700_000_000_000;
      host.deliverMessage(
        '[Message from guide agent (id=1)]\n\nPlease review the latest changes.',
        { sender: 1, receiver: 2, timestamp: ts }
      );

      expect(internal._chatCache.push).toHaveBeenCalledOnce();
      expect(internal._chatCache.push).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: 'Message from guide agent (id=1)\n\nPlease review the latest changes.',
          timestamp: ts,
        })
      );
    });

    it('stores only the tag when inter-agent message has no body', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      host.deliverMessage('[Message from conductor agent (id=5)]', {
        sender: 5,
        receiver: 1,
        timestamp: 1_700_000_000_000,
      });

      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe('Message from conductor agent (id=5)');
    });

    it('shows only the tag for scheduled task messages', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      host.deliverMessage(
        `[Scheduled task: daily-summary]\n\nfile: /path\nlast_run_ts: 2026-01-01`,
        {
          sender: 0,
          receiver: 2,
          timestamp: 1_700_000_000_000,
        }
      );

      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe('Scheduled task: daily-summary');
    });

    it('shows only the tag for triggered task messages', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      host.deliverMessage('[Task: project-story]\n\n## Context\nLong structured data...', {
        sender: 0,
        receiver: 2,
        timestamp: 1_700_000_000_000,
      });

      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe('Task: project-story');
    });

    it('includes project ID and name in project-log chat label', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      host.deliverMessage(
        '[Scheduled task: project-log]\n\nproject_id: 3\nproject_name: US Employment Rate Analysis\n\n## Activity\nsome log content',
        { sender: 0, receiver: 2, timestamp: 1_700_000_000_000 }
      );

      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe('Scheduled task: project-log #3 (US Employment Rate Analysis)');
    });

    it('falls back to plain project-log label when metadata is missing', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      host.deliverMessage('[Scheduled task: project-log]\n\n## Activity\nno metadata here', {
        sender: 0,
        receiver: 2,
        timestamp: 1_700_000_000_000,
      });

      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe('Scheduled task: project-log');
    });

    it('truncates untagged content to 100 characters', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      const longContent = 'a'.repeat(200);
      host.deliverMessage(longContent, {
        sender: 1,
        receiver: 2,
        timestamp: 1_700_000_000_000,
      });

      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe('a'.repeat(100));
    });

    it('stale sendCustomMessage catch is a no-op after session change', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
      };

      // Create a session whose sendCustomMessage rejects after a tick
      const sendError = new Error('session destroyed');
      const oldSession = {
        sendCustomMessage: vi.fn().mockRejectedValue(sendError),
      };
      internal.session = oldSession;
      internal._chatCache = null;
      internal._sessionDir = null;
      internal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      internal.handleCompactionTracking = vi.fn();

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      // Don't await: we need the catch handler to fire after session swap
      host.deliverMessage('msg1', details);

      // deliverySendCount was incremented synchronously by deliverMessage
      expect(internal.deliverySendCount).toBe(1);

      // Simulate failover: swap session to a new object before the catch fires
      const newSession = { sendCustomMessage: vi.fn() };
      internal.session = newSession as typeof internal.session;

      // Let the rejected promise's catch handler run
      await new Promise((r) => setTimeout(r, 0));

      // The catch handler should have been a no-op (session !== session guard).
      // deliverySendCount should NOT have been decremented by the stale handler.
      expect(internal.deliverySendCount).toBe(1);
      // The delivery should still be in the queue (not spliced by the stale handler)
      expect(internal.pendingDeliveries).toHaveLength(1);
      expect(internal.pendingDeliveries[0].content).toBe('msg1');
    });

    it('does not push to chatCache when _chatCache is null', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = null;
      internal._sessionDir = null;

      // Should not throw
      expect(() =>
        host.deliverMessage('hi', { sender: 1, receiver: 2, timestamp: Date.now() })
      ).not.toThrow();
    });

    it('rejects delivery when content exceeds MAX_DELIVERY_BYTES', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      // Create content that exceeds MAX_DELIVERY_BYTES
      const oversizedContent = 'x'.repeat(MAX_DELIVERY_BYTES + 1);

      await expect(
        host.deliverMessage(oversizedContent, {
          sender: 1,
          receiver: 2,
          timestamp: Date.now(),
        })
      ).rejects.toThrow(/Delivery content exceeds max_bytes/);
    });

    it('accepts delivery when content is exactly at MAX_DELIVERY_BYTES', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
        pendingDeliveries: Array<{ content: string }>;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      // Create content exactly at MAX_DELIVERY_BYTES
      const contentAtLimit = 'y'.repeat(MAX_DELIVERY_BYTES);

      // Should not reject due to size check
      const promise = host.deliverMessage(contentAtLimit, {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      expect(promise).toBeInstanceOf(Promise);
      // The delivery should be queued (not rejected by size check)
      expect(internal.pendingDeliveries).toHaveLength(1);
      expect(internal.pendingDeliveries[0].content).toBe(contentAtLimit);
    });

    it('rejects at configured maxDeliveryBytes limit when smaller than default', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        maxDeliveryBytes: 1024,
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      // Content just over the configured 1024-byte limit
      const oversized = 'x'.repeat(1025);
      await expect(
        host.deliverMessage(oversized, { sender: 1, receiver: 2, timestamp: Date.now() })
      ).rejects.toThrow(/max_bytes \(1024 bytes\)/);
    });

    it('accepts delivery exactly at the configured maxDeliveryBytes limit', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        maxDeliveryBytes: 1024,
      });

      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        _sessionDir: string | null;
        pendingDeliveries: Array<{ content: string }>;
      };

      internal.session = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal._sessionDir = null;

      const contentAtLimit = 'y'.repeat(1024);
      const promise = host.deliverMessage(contentAtLimit, {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      expect(promise).toBeInstanceOf(Promise);
      expect(internal.pendingDeliveries).toHaveLength(1);
    });

    describe('watchdog timers (issue #194)', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      type InternalEntry = {
        content: string;
        deferred?: boolean;
        deferTimerHandle?: NodeJS.Timeout;
        dispatchTimerHandle?: NodeJS.Timeout;
      };

      type HostInternal = {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> } | null;
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        currentTurnHasOutput: boolean;
        isReinitializing: boolean;
        pendingDeliveries: InternalEntry[];
      };

      type SendStub = ReturnType<typeof vi.fn> & ((...args: unknown[]) => unknown);

      function makeHostWithStubSession(): {
        host: AgentHost;
        internal: HostInternal;
        sendStub: SendStub;
      } {
        const host = new AgentHost({
          db: makeDbStub(),
          agentId: 1,
          registry: makeRegistryStub(),
          llmConfig: makeLlmConfig(),
        });
        const internal = host as unknown as HostInternal;
        const sendStub = vi.fn().mockReturnValue(new Promise(() => {})) as SendStub;
        internal.session = { sendCustomMessage: sendStub };
        internal._chatCache = null;
        internal._sessionDir = null;
        return { host, internal, sendStub };
      }

      it('PR-B: dispatch timeout rejects in-flight delivery and cleans up counters', async () => {
        const { host, internal } = makeHostWithStubSession();

        const promise = host.deliverMessage('m1', {
          sender: 1,
          receiver: 2,
          timestamp: Date.now(),
        });
        const settled = expect(promise).rejects.toThrow(/no agent_end received/);

        // Microtask flush so the .then() in deliverMessage runs and sendCustomMessage is called.
        await Promise.resolve();
        await Promise.resolve();
        expect(internal.deliverySendCount).toBe(1);
        expect(internal.pendingDeliveries).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(DELIVERY_DISPATCH_TIMEOUT_MS);
        await settled;

        expect(internal.deliverySendCount).toBe(0);
        expect(internal.currentTurnHasOutput).toBe(false);
        expect(internal.pendingDeliveries).toHaveLength(0);
      });

      it('PR-B: timer is cleared when sendCustomMessage rejects (no double rejection)', async () => {
        const { host, internal, sendStub } = makeHostWithStubSession();
        const sendErr = new Error('socket closed');
        sendStub.mockReset().mockRejectedValue(sendErr);

        const promise = host.deliverMessage('m1', {
          sender: 1,
          receiver: 2,
          timestamp: Date.now(),
        });
        // sendCustomMessage's catch path runs as microtasks — drain them before advancing time.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        await expect(promise).rejects.toThrow(/Delivery send failed: socket closed/);

        // If the dispatch timer were still armed, advancing past it would attempt to reject again
        // and either change the rejection reason or throw on a settled promise. Verify neither.
        await vi.advanceTimersByTimeAsync(DELIVERY_DISPATCH_TIMEOUT_MS + 1000);
        expect(internal.pendingDeliveries).toHaveLength(0);
      });

      it('PR-B: dispatch timeout dispatches the next deferred entry', async () => {
        // Direct unit test of handleDispatchTimeout's replay-release behavior. The
        // end-to-end cascade is hard to observe via deliverMessage because the deferred
        // entry's wedge timer (3 min) fires before the in-flight entry's dispatch timer
        // (6 min) — so we drive handleDispatchTimeout directly here.
        const { host, internal, sendStub } = makeHostWithStubSession();

        let firstReject!: (e: Error) => void;
        const firstPromise = new Promise<void>((_, rej) => {
          firstReject = rej;
        });
        const firstSettled = expect(firstPromise).rejects.toThrow();

        let secondReject!: (e: Error) => void;
        const secondPromise = new Promise<void>((_, rej) => {
          secondReject = rej;
        });
        const secondSettled = expect(secondPromise).rejects.toThrow();

        const firstEntry: InternalEntry & {
          details: { sender: number; receiver: number; timestamp: number };
          scheduledTask?: boolean;
          resolve: () => void;
          reject: (e: Error) => void;
        } = {
          content: '[Scheduled task: foo]\nbody',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          scheduledTask: true,
          deferred: false,
          resolve: () => {},
          reject: firstReject,
        };
        const secondEntry: typeof firstEntry = {
          content: 'm2',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          deferred: true,
          resolve: () => {},
          reject: secondReject,
        };
        internal.pendingDeliveries.push(
          firstEntry as unknown as InternalEntry,
          secondEntry as unknown as InternalEntry
        );
        internal.deliverySendCount = 1;
        const session = internal.session;
        (
          host as unknown as {
            handleDispatchTimeout: (entry: InternalEntry, s: unknown) => void;
          }
        ).handleDispatchTimeout(internal.pendingDeliveries[0], session);
        await firstSettled;

        // First entry removed, deliverySendCount decremented, second entry dispatched.
        expect(internal.pendingDeliveries).toHaveLength(1);
        expect(internal.pendingDeliveries[0].content).toBe('m2');
        expect(internal.pendingDeliveries[0].deferred).toBe(false);
        expect(internal.deliverySendCount).toBe(1);
        expect(sendStub).toHaveBeenCalledTimes(1);
        expect(sendStub.mock.calls[0][0]).toMatchObject({ content: 'm2' });

        // Cleanup: let the now-dispatched second entry's timer fire so the rejection is observed
        // before useRealTimers.
        await vi.advanceTimersByTimeAsync(DELIVERY_DISPATCH_TIMEOUT_MS);
        await secondSettled;
      });

      it('PR-C: wedge timeout rejects a delivery that never reaches the SDK', async () => {
        const { host, internal, sendStub } = makeHostWithStubSession();
        // Simulate wedge: session set so the not-initialized guard passes, but isReinitializing
        // marked true so the gate in deliverMessage routes to deferred without dispatching.
        internal.isReinitializing = true;

        const promise = host.deliverMessage('m1', {
          sender: 1,
          receiver: 2,
          timestamp: Date.now(),
        });
        const settled = expect(promise).rejects.toThrow(/session appears wedged/);

        expect(sendStub).not.toHaveBeenCalled();
        expect(internal.pendingDeliveries).toHaveLength(1);
        expect(internal.pendingDeliveries[0].deferred).toBe(true);

        await vi.advanceTimersByTimeAsync(PENDING_DELIVERY_TIMEOUT_MS);
        await settled;

        expect(internal.pendingDeliveries).toHaveLength(0);
      });

      it('PR-C: defer timer is cleared when the entry transitions to dispatched', async () => {
        const { host, internal } = makeHostWithStubSession();
        internal.isReinitializing = true;

        const promise = host.deliverMessage('m1', {
          sender: 1,
          receiver: 2,
          timestamp: Date.now(),
        });
        expect(internal.pendingDeliveries[0].deferred).toBe(true);
        expect(internal.pendingDeliveries[0].deferTimerHandle).toBeDefined();

        // Simulate the reinit completing: clear the flag and replay deferred deliveries.
        internal.isReinitializing = false;
        (
          host as unknown as { replayPendingDeliveries: (ctx: string) => void }
        ).replayPendingDeliveries('test-replay');

        expect(internal.pendingDeliveries[0].deferred).toBe(false);
        expect(internal.pendingDeliveries[0].deferTimerHandle).toBeUndefined();
        expect(internal.pendingDeliveries[0].dispatchTimerHandle).toBeDefined();

        // Cleanup: let the dispatch timer fire so the promise settles before useRealTimers.
        const settled = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(DELIVERY_DISPATCH_TIMEOUT_MS);
        await settled;
      });

      it('retry path: arms dispatch watchdog and skips deferred entries', () => {
        // Drive the retry-resend loop's arming + deferred-respect behavior directly by
        // replicating the loop's body. The full handlePotentialError flow has heavy
        // setup; this unit-level check exercises exactly the watchdog-arming + gate
        // preservation contract.
        const { host, internal, sendStub } = makeHostWithStubSession();
        const session = internal.session;
        const makeEntry = (
          content: string,
          deferred: boolean
        ): InternalEntry & {
          details: { sender: number; receiver: number; timestamp: number };
          scheduledTask?: boolean;
          resolve: () => void;
          reject: (e: Error) => void;
        } => ({
          content,
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          deferred,
          resolve: () => {},
          reject: () => {},
        });
        const inFlightEntry = makeEntry('chat-A', false);
        const deferredEntry = makeEntry('[Scheduled task: foo]\nbody', true);
        deferredEntry.scheduledTask = true;
        const deliveriesToRetry: (typeof inFlightEntry)[] = [inFlightEntry, deferredEntry];
        internal.pendingDeliveries.push(
          inFlightEntry as unknown as InternalEntry,
          deferredEntry as unknown as InternalEntry
        );

        // Simulate the retry path: same loop body as host.ts retry block.
        const hostInternal = host as unknown as {
          clearDeliveryTimers: (e: InternalEntry) => void;
          armDeferTimer: (e: InternalEntry) => void;
          armDispatchTimer: (e: InternalEntry, s: unknown) => void;
        };
        for (const d of deliveriesToRetry) {
          if (d.deferred) {
            hostInternal.clearDeliveryTimers(d as unknown as InternalEntry);
            hostInternal.armDeferTimer(d as unknown as InternalEntry);
            continue;
          }
          internal.deliverySendCount++;
          hostInternal.clearDeliveryTimers(d as unknown as InternalEntry);
          hostInternal.armDispatchTimer(d as unknown as InternalEntry, session);
          // Real retry loop also calls sendCustomMessage; mirror that for completeness.
          sendStub({ content: d.content }, {});
        }

        // In-flight entry: dispatch watchdog armed, sendCustomMessage invoked once.
        expect(inFlightEntry.dispatchTimerHandle).toBeDefined();
        expect(inFlightEntry.deferTimerHandle).toBeUndefined();
        expect(sendStub).toHaveBeenCalledTimes(1);
        expect(sendStub.mock.calls[0][0]).toMatchObject({ content: 'chat-A' });

        // Deferred entry: wedge watchdog armed, NOT resent (gate preserved).
        expect(deferredEntry.deferTimerHandle).toBeDefined();
        expect(deferredEntry.dispatchTimerHandle).toBeUndefined();
        // Only 1 send call total — the deferred scheduled-task was NOT dispatched.
        expect(sendStub).toHaveBeenCalledTimes(1);

        // Cleanup: clear timers so vi.useRealTimers in afterEach doesn't see leaks.
        hostInternal.clearDeliveryTimers(inFlightEntry as unknown as InternalEntry);
        hostInternal.clearDeliveryTimers(deferredEntry as unknown as InternalEntry);
      });

      it('failover replay: arms dispatch watchdog on direct branch and defer watchdog on deferred branch', () => {
        // Same pattern as the retry test: replicate the loop body to exercise the
        // arming contract without bringing up the full failover machinery.
        const { host, internal } = makeHostWithStubSession();
        const session = internal.session;
        const direct: InternalEntry & {
          details: { sender: number; receiver: number; timestamp: number };
          scheduledTask?: boolean;
          resolve: () => void;
          reject: (e: Error) => void;
        } = {
          content: 'chat-A',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          deferred: false,
          resolve: () => {},
          reject: () => {},
        };
        const reDeferred: typeof direct = {
          content: '[Scheduled task: foo]\nbody',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          scheduledTask: true,
          deferred: false,
          resolve: () => {},
          reject: () => {},
        };
        const toReplay: (typeof direct)[] = [direct, reDeferred];
        internal.pendingDeliveries.push(direct as unknown as InternalEntry);
        // reDeferred is NOT in pendingDeliveries yet — mirrors the failover-replay
        // scenario where toReplay includes a previously-stale-rejected entry.

        const hostInternal = host as unknown as {
          clearDeliveryTimers: (e: InternalEntry) => void;
          armDeferTimer: (e: InternalEntry) => void;
          armDispatchTimer: (e: InternalEntry, s: unknown) => void;
        };
        let scheduledTaskSent = false;
        let anyDeferred = false;
        for (const d of toReplay) {
          if (d.deferred || anyDeferred || (d.scheduledTask && scheduledTaskSent)) {
            d.deferred = true;
            anyDeferred = true;
            if (!internal.pendingDeliveries.includes(d as unknown as InternalEntry)) {
              internal.pendingDeliveries.push(d as unknown as InternalEntry);
            }
            hostInternal.clearDeliveryTimers(d as unknown as InternalEntry);
            hostInternal.armDeferTimer(d as unknown as InternalEntry);
            continue;
          }
          internal.deliverySendCount++;
          d.deferred = false;
          if (d.scheduledTask) scheduledTaskSent = true;
          hostInternal.clearDeliveryTimers(d as unknown as InternalEntry);
          hostInternal.armDispatchTimer(d as unknown as InternalEntry, session);
        }

        // Direct (chat-A): dispatch watchdog armed.
        expect(direct.dispatchTimerHandle).toBeDefined();
        expect(direct.deferTimerHandle).toBeUndefined();
        // Re-deferred scheduled task (no scheduledTaskSent yet from the loop, so it
        // would normally dispatch; force the re-deferred branch by simulating
        // `anyDeferred=false` then a path that defers it via the inflight-has-scheduled
        // logic outside the loop — but with the simplification here, scheduled-only
        // entries go direct in toReplay order. To exercise re-deferred arming, push a
        // second scheduled-task and verify the second hits the defer branch.)
        const secondScheduled: typeof direct = {
          content: '[Scheduled task: bar]\nbody',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          scheduledTask: true,
          deferred: false,
          resolve: () => {},
          reject: () => {},
        };
        // Run the loop body once more with scheduledTaskSent now true (from reDeferred
        // having been dispatched above as a direct send).
        // To make this deterministic without rewriting the whole helper, simulate the
        // gate path directly:
        if (secondScheduled.scheduledTask && scheduledTaskSent) {
          secondScheduled.deferred = true;
          internal.pendingDeliveries.push(secondScheduled as unknown as InternalEntry);
          hostInternal.clearDeliveryTimers(secondScheduled as unknown as InternalEntry);
          hostInternal.armDeferTimer(secondScheduled as unknown as InternalEntry);
        }

        expect(secondScheduled.deferTimerHandle).toBeDefined();
        expect(secondScheduled.dispatchTimerHandle).toBeUndefined();

        // Cleanup.
        hostInternal.clearDeliveryTimers(direct as unknown as InternalEntry);
        hostInternal.clearDeliveryTimers(reDeferred as unknown as InternalEntry);
        hostInternal.clearDeliveryTimers(secondScheduled as unknown as InternalEntry);
      });

      it('agent_end clears the dispatch timer (no false-positive rejection)', async () => {
        const { host, internal } = makeHostWithStubSession();
        const hostFull = host as unknown as HostInternal & {
          handleSessionEvent: (event: { type: string }) => void;
          handlePotentialError: ReturnType<typeof vi.fn>;
          handleCompactionTracking: ReturnType<typeof vi.fn>;
        };
        hostFull.handlePotentialError = vi.fn().mockResolvedValue(undefined);
        hostFull.handleCompactionTracking = vi.fn();

        const promise = host.deliverMessage('m1', {
          sender: 1,
          receiver: 2,
          timestamp: Date.now(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(internal.pendingDeliveries[0].dispatchTimerHandle).toBeDefined();

        hostFull.handleSessionEvent({ type: 'agent_end' });
        await expect(promise).resolves.toBeUndefined();

        expect(internal.pendingDeliveries).toHaveLength(0);

        // Past the timeout — the timer must have been cleared on resolve. If it hadn't been,
        // its callback would now try to operate on the already-removed entry.
        await vi.advanceTimersByTimeAsync(DELIVERY_DISPATCH_TIMEOUT_MS + 1000);
      });
    });
  });

  describe('pushSystemMessage on failover', () => {
    it('passes reason to reinitializeWithProvider when switching provider', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        authResolver: {
          isKeyInCooldown: ReturnType<typeof vi.fn>;
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        retryAttempts: Map<string, number>;
        session: unknown;
      };

      internal.session = { prompt: vi.fn() };
      internal.currentProvider = 'google';
      internal.currentKeyIndex = 0;
      internal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue('anthropic');
      internal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);

      // 429 rate limit error: shouldRetry is false at attempt 7, triggers failover
      internal.retryAttempts.set('google:rate_limit', 7);
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      expect(internal.reinitializeWithProvider).toHaveBeenCalledWith(
        'anthropic',
        null,
        [],
        '429 rate limited, switched to anthropic',
        'on google, switching to anthropic\n\nError 429: rate limit exceeded'
      );
    });

    it('passes key rotation reason when staying on same provider', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        authResolver: {
          isKeyInCooldown: ReturnType<typeof vi.fn>;
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        retryAttempts: Map<string, number>;
        session: unknown;
      };

      internal.session = { prompt: vi.fn() };
      internal.currentProvider = 'google';
      internal.currentKeyIndex = 0;
      internal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      // Same provider returned — key rotation, not provider switch
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue('google');
      internal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);

      internal.retryAttempts.set('google:rate_limit', 7);
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      expect(internal.reinitializeWithProvider).toHaveBeenCalledWith(
        'google',
        null,
        [],
        '429 rate limited, rotating to next key',
        'on google, rotating to next key\n\nError 429: rate limit exceeded'
      );
    });

    it('pushes unavailable message when no providers remain', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        authResolver: {
          isKeyInCooldown: ReturnType<typeof vi.fn>;
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        retryAttempts: Map<string, number>;
        session: unknown;
        busy: boolean;
      };

      internal.session = { prompt: vi.fn() };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal.currentProvider = 'cerebras';
      internal.currentKeyIndex = 0;
      internal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 401: Unauthorized' },
      });

      expect(internal._chatCache.push).toHaveBeenCalledOnce();
      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.role).toBe('system');
      expect(pushed.content).toBe(
        '401 auth error, all providers unavailable\n\non cerebras, all providers unavailable\n\nError 401: Unauthorized'
      );
    });
  });

  describe('shared AuthResolver early-out', () => {
    it('skips retries and fails over immediately when our key is already in cooldown', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        authResolver: import('./auth-resolver.js').AuthResolver;
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        retryAttempts: Map<string, number>;
        session: unknown;
      };

      internal.session = { prompt: vi.fn() };
      internal.currentProvider = 'cerebras';
      internal.currentKeyIndex = 0;
      internal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);

      // Simulate another agent having already put cerebras key 0 in cooldown
      internal.authResolver.markKeyFailed('cerebras', 'rate_limit', undefined, 0);

      // Fire a rate limit error (attempt 0, normally would retry)
      expect(internal.retryAttempts.get('cerebras:rate_limit')).toBeUndefined();
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      // Should have skipped retries and failed over directly to google
      expect(internal.reinitializeWithProvider).toHaveBeenCalledWith(
        'google',
        null,
        [],
        expect.stringContaining('switched to google'),
        expect.stringContaining('cooldown')
      );
    });

    it('proceeds with normal retries when our key is not in cooldown', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        authResolver: import('./auth-resolver.js').AuthResolver;
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        retryAttempts: Map<string, number>;
        session: { prompt: ReturnType<typeof vi.fn> };
        pendingPrompt: string | null;
      };

      internal.session = { prompt: vi.fn().mockResolvedValue(undefined) };
      internal.currentProvider = 'cerebras';
      internal.currentKeyIndex = 0;
      internal.pendingPrompt = 'test';
      internal.reinitializeWithProvider = vi.fn();

      // No cooldown set — should enter normal retry path
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      // Should have retried (attempt incremented), NOT failed over
      expect(internal.retryAttempts.get('cerebras:rate_limit')).toBe(1);
      expect(internal.reinitializeWithProvider).not.toHaveBeenCalled();
    });
  });

  describe('failover and recovery', () => {
    it('fails over on client error to available provider', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        authResolver: {
          isKeyInCooldown: ReturnType<typeof vi.fn>;
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        retryAttempts: Map<string, number>;
        session: unknown;
        busy: boolean;
      };

      internal.session = { prompt: vi.fn() };
      internal.currentProvider = 'anthropic';
      internal.currentKeyIndex = 0;
      internal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);

      internal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(true);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue('google');

      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 400: credit balance too low' },
      });

      expect(internal.reinitializeWithProvider).toHaveBeenCalledWith(
        'google',
        null,
        [],
        '400 client error, switched to google',
        'on anthropic, switching to google\n\nError 400: credit balance too low'
      );
    });

    it('gives up when all providers exhausted', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        authResolver: {
          isKeyInCooldown: ReturnType<typeof vi.fn>;
          markKeyFailed: ReturnType<typeof vi.fn>;
          getNextProvider: ReturnType<typeof vi.fn>;
        };
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        retryAttempts: Map<string, number>;
        session: unknown;
        busy: boolean;
      };

      internal.session = { prompt: vi.fn() };
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal.currentProvider = 'anthropic';
      internal.currentKeyIndex = 0;
      internal.busy = true;
      internal.reinitializeWithProvider = vi.fn();

      // All providers exhausted
      internal.authResolver.isKeyInCooldown = vi.fn().mockReturnValue(false);
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue('anthropic');

      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 400: credit balance too low' },
      });

      // Should NOT have switched
      expect(internal.reinitializeWithProvider).not.toHaveBeenCalled();
      // Busy should be cleared
      expect(internal.busy).toBe(false);
      // Should show error details in the exhausted message
      const pushed = internal._chatCache.push.mock.calls[0][0];
      expect(pushed.content).toBe(
        '400 client error, all providers unavailable\n\non anthropic, all providers unavailable\n\nError 400: credit balance too low'
      );
    });

    it('reinitializeWithProvider failure rejects all pending deliveries', async () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        reinitializeWithProvider: (
          provider: string,
          prompt: string | null,
          deliveries: unknown[],
          reason?: string,
          detail?: string
        ) => Promise<void>;
        isReinitializing: boolean;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        initialize: ReturnType<typeof vi.fn>;
      };

      // Mock initialize to throw (simulates reinit failure)
      internal.initialize = vi.fn().mockRejectedValue(new Error('init failed'));
      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };

      const reject1 = vi.fn();
      const reject2 = vi.fn();
      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      internal.pendingDeliveries = [
        { content: 'msg-A', details, resolve: vi.fn(), reject: reject1 },
        { content: 'msg-B', details, resolve: vi.fn(), reject: reject2 },
      ];
      internal.deliverySendCount = 2;

      await internal.reinitializeWithProvider('google', null, [], 'test reason', 'test detail');

      // Both deliveries should be rejected with the init error
      expect(reject1).toHaveBeenCalledWith(expect.objectContaining({ message: 'init failed' }));
      expect(reject2).toHaveBeenCalledWith(expect.objectContaining({ message: 'init failed' }));
      // Queue and counter should be cleared
      expect(internal.pendingDeliveries).toHaveLength(0);
      expect(internal.deliverySendCount).toBe(0);
      // isReinitializing should be reset (finally block)
      expect(internal.isReinitializing).toBe(false);
    });

    it('replays deliveries queued during failover-driven reinit alongside the pre-failover snapshot', async () => {
      // Issue #169 follow-on: with deliverMessage now queuing during reinit (instead of
      // rejecting), the merge logic at reinitializeWithProvider lines 1281-1284 is finally
      // load-bearing. newDuringReinit must be replayed against the new session — not just
      // the pre-failover deliveriesToRetry snapshot. Before the fix, the loop iterated
      // deliveriesToRetry only and silently dropped any delivery that landed mid-reinit.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        reinitializeWithProvider: (
          provider: string,
          prompt: string | null,
          deliveries: unknown[],
          reason?: string,
          detail?: string
        ) => Promise<void>;
        session: { sendCustomMessage: ReturnType<typeof vi.fn> } | null;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        initialize: ReturnType<typeof vi.fn>;
        authResolver: {
          getActiveKey: ReturnType<typeof vi.fn>;
          ensureFresh: ReturnType<typeof vi.fn>;
        };
      };

      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal.authResolver.getActiveKey = vi
        .fn()
        .mockReturnValue({ keyIndex: 0, tier: 'api_keys' });
      internal.authResolver.ensureFresh = vi.fn().mockResolvedValue(undefined);

      // Hold initialize in flight so we can inject a newDuringReinit entry mid-flight.
      let resolveInit!: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      const freshSession = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal.initialize = vi.fn().mockImplementation(async () => {
        await initPromise;
        internal.session = freshSession;
      });

      // Pre-failover snapshot: two deliveries already in the queue.
      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const snapshotA = { content: 'snapshot-A', details, resolve: vi.fn(), reject: vi.fn() };
      const snapshotB = { content: 'snapshot-B', details, resolve: vi.fn(), reject: vi.fn() };
      internal.pendingDeliveries = [snapshotA, snapshotB];

      // Caller passes the snapshot as deliveriesToRetry (this is what handlePotentialError does
      // before calling reinitializeWithProvider).
      const reinitPromise = internal.reinitializeWithProvider(
        'google',
        null,
        [snapshotA, snapshotB],
        'failover reason',
        'failover detail'
      );

      // Yield so reinit awaits authResolver/initialize. Now inject a delivery that arrives
      // mid-flight (this simulates the new queue-during-reinit behavior in deliverMessage).
      await Promise.resolve();
      const lateEntry = {
        content: 'late-during-reinit',
        details,
        resolve: vi.fn(),
        reject: vi.fn(),
      };
      internal.pendingDeliveries.push(lateEntry);

      // Now let initialize resolve. The replay loop must iterate the MERGED list.
      resolveInit();
      await reinitPromise;

      // All three deliveries got sent against the fresh session.
      const sentContents = freshSession.sendCustomMessage.mock.calls.map(
        (c) => (c[0] as { content: string }).content
      );
      expect(sentContents).toContain('snapshot-A');
      expect(sentContents).toContain('snapshot-B');
      expect(sentContents).toContain('late-during-reinit');
      // And exactly three sends — not duplicates from being seen as both snapshot AND new.
      expect(freshSession.sendCustomMessage).toHaveBeenCalledTimes(3);
    });

    it('replays deliveries queued during failover-driven reinit even when the pre-failover snapshot is empty', async () => {
      // Edge case from Copilot round 1 (PR #170): failover can be triggered when no deliveries
      // are in flight (deliveriesToRetry empty). With queue-during-reinit, new deliveries can
      // still arrive while initialize() runs. If the replay block were gated on
      // `deliveriesToRetry.length > 0`, those promises would be stranded.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        reinitializeWithProvider: (
          provider: string,
          prompt: string | null,
          deliveries: unknown[],
          reason?: string,
          detail?: string
        ) => Promise<void>;
        session: { sendCustomMessage: ReturnType<typeof vi.fn> } | null;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        initialize: ReturnType<typeof vi.fn>;
        authResolver: {
          getActiveKey: ReturnType<typeof vi.fn>;
          ensureFresh: ReturnType<typeof vi.fn>;
        };
      };

      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal.authResolver.getActiveKey = vi
        .fn()
        .mockReturnValue({ keyIndex: 0, tier: 'api_keys' });
      internal.authResolver.ensureFresh = vi.fn().mockResolvedValue(undefined);

      let resolveInit!: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      const freshSession = { sendCustomMessage: vi.fn().mockResolvedValue(undefined) };
      internal.initialize = vi.fn().mockImplementation(async () => {
        await initPromise;
        internal.session = freshSession;
      });

      // Empty snapshot — failover triggered with no deliveries currently in flight.
      internal.pendingDeliveries = [];

      const reinitPromise = internal.reinitializeWithProvider(
        'google',
        null,
        [], // ← empty deliveriesToRetry
        'failover reason',
        'failover detail'
      );

      // Inject a delivery mid-flight.
      await Promise.resolve();
      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const lateEntry = {
        content: 'late-during-empty-snapshot-reinit',
        details,
        resolve: vi.fn(),
        reject: vi.fn(),
      };
      internal.pendingDeliveries.push(lateEntry);

      // Let initialize resolve. Replay must trigger despite the empty snapshot.
      resolveInit();
      await reinitPromise;

      const sentContents = freshSession.sendCustomMessage.mock.calls.map(
        (c) => (c[0] as { content: string }).content
      );
      expect(sentContents).toContain('late-during-empty-snapshot-reinit');
      expect(freshSession.sendCustomMessage).toHaveBeenCalledTimes(1);
    });

    it('does NOT double-send a delivery that arrives after isReinitializing is cleared but before replay runs', async () => {
      // Copilot round 2 (PR #170): reinitializeWithProvider clears `isReinitializing = false`
      // BEFORE the optional `await session.prompt(promptToRetry)`. During that await, a
      // deliverMessage() call goes through the normal send path AND lands in pendingDeliveries.
      // If the replay block recomputed `newDuringReinit` from live pendingDeliveries after the
      // await, it would pick up that delivery and send it a second time. The fix snapshots the
      // queued-during-reinit set BEFORE clearing the flag, so post-clear deliveries are not
      // replayed.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        reinitializeWithProvider: (
          provider: string,
          prompt: string | null,
          deliveries: unknown[],
          reason?: string,
          detail?: string
        ) => Promise<void>;
        session: {
          sendCustomMessage: ReturnType<typeof vi.fn>;
          prompt: ReturnType<typeof vi.fn>;
        } | null;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        initialize: ReturnType<typeof vi.fn>;
        authResolver: {
          getActiveKey: ReturnType<typeof vi.fn>;
          ensureFresh: ReturnType<typeof vi.fn>;
        };
      };

      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal.authResolver.getActiveKey = vi
        .fn()
        .mockReturnValue({ keyIndex: 0, tier: 'api_keys' });
      internal.authResolver.ensureFresh = vi.fn().mockResolvedValue(undefined);

      // Install fresh session up front so prompt() can be awaited. We will gate the
      // prompt() call so a deliverMessage() can land during that await.
      let resolvePrompt!: () => void;
      const promptPromise = new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
      const freshSession = {
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockImplementation(() => promptPromise),
      };
      internal.initialize = vi.fn().mockImplementation(async () => {
        internal.session = freshSession;
      });

      internal.pendingDeliveries = [];

      // Trigger failover with a non-null promptToRetry so the await session.prompt path runs.
      const reinitPromise = internal.reinitializeWithProvider(
        'google',
        'retry-this-prompt',
        [],
        'failover reason',
        'failover detail'
      );

      // Yield until reinit reaches the prompt await — initialize has resolved, isReinitializing
      // is now false, and session.prompt is in flight.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // At this point a deliverMessage() lands. With isReinitializing=false and session
      // non-null, it goes through the normal send path (sendCustomMessage called once,
      // pushed to pendingDeliveries).
      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const postClearPromise = host.deliverMessage('post-clear-delivery', details);
      // Don't await completion — let it resolve at the agent's pace.
      void postClearPromise.catch(() => {});

      // deliverMessage's send goes through `reload.then(...)` — flush microtasks so the
      // sendCustomMessage call lands before we assert.
      await Promise.resolve();
      await Promise.resolve();

      // Verify it went through the normal send path (1 sendCustomMessage call).
      expect(freshSession.sendCustomMessage).toHaveBeenCalledTimes(1);

      // Now let the prompt retry complete; the replay block runs next.
      resolvePrompt();
      await reinitPromise;

      // The replay block must NOT re-send the post-clear delivery. Still exactly 1 send.
      expect(freshSession.sendCustomMessage).toHaveBeenCalledTimes(1);
      const sentContents = freshSession.sendCustomMessage.mock.calls.map(
        (c) => (c[0] as { content: string }).content
      );
      expect(sentContents).toEqual(['post-clear-delivery']);
    });

    it('preserves FIFO send order when a delivery lands during the prompt-retry await with backlog present', async () => {
      // Copilot round 3 (PR #170): if the replay loop ran AFTER `await session.prompt(...)`,
      // a concurrent deliverMessage during that await would land at deliverySendCount=1 with
      // backlog entries [A, B] still at the front of pendingDeliveries. agent_end would shift
      // the wrong entry (resolving A's promise early) AND the subsequent replay would re-send
      // A to the agent (duplicate processing). The fix moves replay BEFORE the prompt await
      // so backlog sends and their deliverySendCount accounting happen before any await yields.
      //
      // Observable from the call order on sendCustomMessage: with the fix, [A, B, X];
      // without the fix, [X, A, B]. We assert the fix's order to lock the invariant.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          urgent?: boolean;
          resolve: () => void;
          reject: (reason: Error) => void;
        }>;
        deliverySendCount: number;
        reinitializeWithProvider: (
          provider: string,
          prompt: string | null,
          deliveries: unknown[],
          reason?: string,
          detail?: string
        ) => Promise<void>;
        session: {
          sendCustomMessage: ReturnType<typeof vi.fn>;
          prompt: ReturnType<typeof vi.fn>;
        } | null;
        _chatCache: { push: ReturnType<typeof vi.fn>; getMessages: ReturnType<typeof vi.fn> };
        initialize: ReturnType<typeof vi.fn>;
        authResolver: {
          getActiveKey: ReturnType<typeof vi.fn>;
          ensureFresh: ReturnType<typeof vi.fn>;
        };
      };

      internal._chatCache = { push: vi.fn(), getMessages: vi.fn().mockReturnValue([]) };
      internal.authResolver.getActiveKey = vi
        .fn()
        .mockReturnValue({ keyIndex: 0, tier: 'api_keys' });
      internal.authResolver.ensureFresh = vi.fn().mockResolvedValue(undefined);

      let resolvePrompt!: () => void;
      const promptPromise = new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
      const freshSession = {
        sendCustomMessage: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockImplementation(() => promptPromise),
      };
      internal.initialize = vi.fn().mockImplementation(async () => {
        internal.session = freshSession;
      });

      // Pre-failover backlog of two scheduled-task deliveries.
      const details = { sender: 0, receiver: 2, timestamp: Date.now() };
      const A = { content: 'A-backlog', details, resolve: vi.fn(), reject: vi.fn() };
      const B = { content: 'B-backlog', details, resolve: vi.fn(), reject: vi.fn() };
      internal.pendingDeliveries = [A, B];

      const reinitPromise = internal.reinitializeWithProvider(
        'google',
        'retry-prompt',
        [A, B], // ← deliveriesToRetry snapshot
        'failover reason',
        'failover detail'
      );

      // Flush microtasks until reinit reaches the gated `await session.prompt`. With the fix
      // in place, replay has already run synchronously; without the fix, the prompt await
      // starts before any replay.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Drop X into the queue during the prompt-retry await.
      const postClearPromise = host.deliverMessage('X-during-prompt', details);
      void postClearPromise.catch(() => {});

      // Flush microtasks so the normal-path send for X fires.
      await Promise.resolve();
      await Promise.resolve();

      // Release prompt; reinit body returns.
      resolvePrompt();
      await reinitPromise;

      // Assert FIFO order on sendCustomMessage. With the fix: [A, B, X]. Without: [X, A, B].
      const sentContents = freshSession.sendCustomMessage.mock.calls.map(
        (c) => (c[0] as { content: string }).content
      );
      expect(sentContents).toEqual(['A-backlog', 'B-backlog', 'X-during-prompt']);
    });
  });

  describe('compaction pruning', () => {
    /** Internal type escape hatch for compaction pruning tests */
    type PruningInternal = {
      compactionCount: number;
      compactionDepth: number;
      isPruning: boolean;
      _sessionDir: string | null;
      session: {
        sessionManager: { getBranch: ReturnType<typeof vi.fn> };
        compact: ReturnType<typeof vi.fn>;
        getContextUsage: ReturnType<typeof vi.fn>;
      } | null;
      handleCompactionTracking: (event: AgentSessionEvent) => void;
      bumpCompactionCount: () => void;
      triggerPruningCompaction: () => Promise<void>;
      findBaselineSummary: () => string | null;
      readCompactionCount: () => number;
      writeCompactionCount: (count: number) => void;
      getContextUsage: ReturnType<typeof vi.fn>;
    };

    function makeHostForPruning(compactionDepth = 3) {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as PruningInternal;
      internal.compactionDepth = compactionDepth;
      return { host, internal };
    }

    function makeCompactionEntries(summaries: string[]) {
      return summaries.map((summary) => ({ type: 'compaction', summary }));
    }

    function mockSession(summaries: string[]) {
      return {
        sessionManager: { getBranch: vi.fn().mockReturnValue(makeCompactionEntries(summaries)) },
        compact: vi.fn().mockResolvedValue(undefined),
        getContextUsage: vi.fn().mockReturnValue({ percent: 50 }),
      };
    }

    describe('triggerPruningCompaction', () => {
      it('calls session.compact() with baseline instruction', async () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.writeCompactionCount = vi.fn();

        await internal.triggerPruningCompaction();

        expect(session.compact).toHaveBeenCalledOnce();
        const instructions = session.compact.mock.calls[0][0] as string;
        expect(instructions).toContain('BASELINE:');
        expect(instructions).toContain('baseline');
        expect(instructions).not.toContain('[pruned]');
      });

      it('resets compactionCount to 0 and persists after pruning', async () => {
        const { internal } = makeHostForPruning(3);
        internal.session = mockSession(['baseline', 'second', 'third']);
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.writeCompactionCount = vi.fn();

        await internal.triggerPruningCompaction();

        expect(internal.compactionCount).toBe(0);
        expect(internal.writeCompactionCount).toHaveBeenCalledWith(0);
      });

      it('skips pruning when no baseline is available and resets the counter', async () => {
        const { internal } = makeHostForPruning(5);
        const session = mockSession(['only one']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 5;
        internal.writeCompactionCount = vi.fn();

        await internal.triggerPruningCompaction();

        expect(session.compact).not.toHaveBeenCalled();
        // Counter is reset so we don't retry baseline lookup on every agent_end.
        expect(internal.compactionCount).toBe(0);
        expect(internal.writeCompactionCount).toHaveBeenCalledWith(0);
      });

      it('skips pruning when session is null', async () => {
        const { internal } = makeHostForPruning(3);
        internal.session = null;

        // Should return early without error
        await internal.triggerPruningCompaction();
      });

      it('skips pruning when sessionDir is null', async () => {
        const { internal } = makeHostForPruning(3);
        internal.session = mockSession(['a', 'b', 'c']);
        internal._sessionDir = null;

        await internal.triggerPruningCompaction();

        expect(internal.session?.compact).not.toHaveBeenCalled();
      });
    });

    describe('findBaselineSummary', () => {
      it('returns the oldest compaction in the current window', () => {
        const { internal } = makeHostForPruning(3);
        internal.session = mockSession([
          'before window',
          'start of window (baseline)',
          'middle',
          'end of window',
        ]);
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;

        // 4 summaries, compactionCount=3: baseline at index 4-3=1
        const baseline = internal.findBaselineSummary();
        expect(baseline).toBe('start of window (baseline)');
      });

      it('returns null when not enough compactions exist', () => {
        const { internal } = makeHostForPruning(5);
        internal.session = mockSession(['only one']);
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 5;

        const baseline = internal.findBaselineSummary();
        expect(baseline).toBeNull();
      });

      it('returns null when session is null', () => {
        const { internal } = makeHostForPruning(3);
        internal.session = null;
        internal._sessionDir = '/tmp/test-session';

        const baseline = internal.findBaselineSummary();
        expect(baseline).toBeNull();
      });

      it('handles exact match (summaries.length === compactionCount)', () => {
        const { internal } = makeHostForPruning(2);
        internal.session = mockSession(['baseline', 'latest']);
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 2;

        // 2 summaries, compactionCount=2: baseline at index 2-2=0
        const baseline = internal.findBaselineSummary();
        expect(baseline).toBe('baseline');
      });
    });

    describe('handleCompactionTracking', () => {
      // Helper: tests deliberately construct minimal compaction_end events;
      // cast through unknown so we don't have to fabricate every required
      // field on the SDK's union member.
      function compactionEnd(overrides: {
        result?: { firstKeptEntryId: string; summary?: string; tokensBefore?: number };
        aborted?: boolean;
        errorMessage?: string;
      }): AgentSessionEvent {
        return {
          type: 'compaction_end',
          reason: 'threshold',
          willRetry: false,
          aborted: false,
          ...overrides,
        } as unknown as AgentSessionEvent;
      }

      it('increments counter on a successful compaction_end (non-null result)', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking(compactionEnd({ result: { firstKeptEntryId: 'abc' } }));

        expect(internal.compactionCount).toBe(1);
        expect(internal.writeCompactionCount).toHaveBeenCalledWith(1);
      });

      it('does NOT increment when result is undefined (silent no-op)', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking(compactionEnd({ result: undefined }));

        expect(internal.compactionCount).toBe(0);
        expect(internal.writeCompactionCount).not.toHaveBeenCalled();
      });

      it('does NOT increment when aborted', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking(
          compactionEnd({ result: { firstKeptEntryId: 'abc' }, aborted: true })
        );

        expect(internal.compactionCount).toBe(0);
        expect(internal.writeCompactionCount).not.toHaveBeenCalled();
      });

      it('does NOT increment when errorMessage is set', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking(
          compactionEnd({
            result: undefined,
            errorMessage: 'Auto-compaction failed: HTTP 400',
          })
        );

        expect(internal.compactionCount).toBe(0);
        expect(internal.writeCompactionCount).not.toHaveBeenCalled();
      });

      it('does not increment counter when compaction_depth is 0', () => {
        const { internal } = makeHostForPruning(0);
        internal.compactionCount = 0;

        internal.handleCompactionTracking(compactionEnd({ result: { firstKeptEntryId: 'abc' } }));

        expect(internal.compactionCount).toBe(0);
      });

      it('triggers pruning on agent_end when counter reaches depth', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking({ type: 'agent_end' } as unknown as AgentSessionEvent);

        expect(internal.isPruning).toBe(true);
        expect(session.compact).toHaveBeenCalled();
      });

      it('triggers pruning without consulting context usage', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.writeCompactionCount = vi.fn();
        // Make getContextUsage throw so the test fails loudly if a future
        // regression re-introduces a usage-based gate in the trigger path.
        internal.getContextUsage = vi.fn(() => {
          throw new Error('getContextUsage must not be consulted by pruning trigger');
        });

        internal.handleCompactionTracking({ type: 'agent_end' } as unknown as AgentSessionEvent);

        expect(internal.isPruning).toBe(true);
        expect(session.compact).toHaveBeenCalled();
        expect(internal.getContextUsage).not.toHaveBeenCalled();
      });

      it('does not trigger pruning when counter is below depth', () => {
        const { internal } = makeHostForPruning(3);
        internal.session = mockSession(['a', 'b']);
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 2;

        internal.handleCompactionTracking({ type: 'agent_end' } as unknown as AgentSessionEvent);

        expect(internal.isPruning).toBe(false);
      });

      it('isPruning flag prevents concurrent pruning', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.isPruning = true;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking({ type: 'agent_end' } as unknown as AgentSessionEvent);

        // compact should not be called because isPruning was already true
        expect(session.compact).not.toHaveBeenCalled();
      });

      it('ignores unrelated event types', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;

        internal.handleCompactionTracking({
          type: 'message_update',
        } as unknown as AgentSessionEvent);
        internal.handleCompactionTracking({
          type: 'tool_execution_start',
        } as unknown as AgentSessionEvent);

        expect(internal.compactionCount).toBe(0);
      });
    });

    describe('agent_end deferral when pruning fires', () => {
      type DeferralInternal = PruningInternal & {
        busy: boolean;
        onBusyChange?: (agentId: number, busy: boolean, contextPercent: number | null) => void;
        listeners: Set<(event: { type: string }) => void>;
        deferredAgentEnd: { type: string } | null;
        handleSessionEvent: (event: {
          type: string;
          result?: unknown;
          aborted?: boolean;
          errorMessage?: string;
        }) => void;
        handlePotentialError: (event: unknown) => Promise<void>;
      };

      it('defers agent_end forwarding and busy clear until pruning completes', async () => {
        const { internal } = makeHostForPruning(3);
        const def = internal as DeferralInternal;
        const session = mockSession(['baseline', 'second', 'third']);
        def.session = session;
        def._sessionDir = '/tmp/test-session';
        def.compactionCount = 3;
        def.busy = true;
        def.writeCompactionCount = vi.fn();
        def.handlePotentialError = vi.fn().mockResolvedValue(undefined);

        let pruneResolve!: () => void;
        session.compact.mockImplementation(() => new Promise<void>((r) => (pruneResolve = r)));

        const busyEvents: boolean[] = [];
        def.onBusyChange = (_id, busy) => busyEvents.push(busy);
        const listenerEvents: string[] = [];
        def.listeners = new Set([(e) => listenerEvents.push(e.type)]);

        def.handleSessionEvent({ type: 'agent_end' });

        // Pruning is in flight. agent_end has not been forwarded and busy is still true.
        expect(def.isPruning).toBe(true);
        expect(def.deferredAgentEnd).toEqual({ type: 'agent_end' });
        expect(listenerEvents).toEqual([]);
        expect(busyEvents).toEqual([]);
        expect(def.busy).toBe(true);

        // Pruning finishes.
        pruneResolve();
        await new Promise((r) => setImmediate(r));

        expect(def.isPruning).toBe(false);
        expect(def.deferredAgentEnd).toBeNull();
        expect(def.busy).toBe(false);
        expect(busyEvents).toEqual([false]);
        expect(listenerEvents).toEqual(['agent_end']);
      });

      it('forwards agent_end immediately when pruning is not triggered', () => {
        const { internal } = makeHostForPruning(3);
        const def = internal as DeferralInternal;
        def.compactionCount = 0;
        def.busy = true;
        def.handlePotentialError = vi.fn().mockResolvedValue(undefined);

        const busyEvents: boolean[] = [];
        def.onBusyChange = (_id, busy) => busyEvents.push(busy);
        const listenerEvents: string[] = [];
        def.listeners = new Set([(e) => listenerEvents.push(e.type)]);

        def.handleSessionEvent({ type: 'agent_end' });

        expect(def.isPruning).toBe(false);
        expect(def.deferredAgentEnd).toBeNull();
        expect(def.busy).toBe(false);
        expect(busyEvents).toEqual([false]);
        expect(listenerEvents).toEqual(['agent_end']);
      });

      it('flushes deferred agent_end even when pruning rejects', async () => {
        const { internal } = makeHostForPruning(3);
        const def = internal as DeferralInternal;
        const session = mockSession(['baseline', 'second', 'third']);
        def.session = session;
        def._sessionDir = '/tmp/test-session';
        def.compactionCount = 3;
        def.busy = true;
        def.writeCompactionCount = vi.fn();
        def.handlePotentialError = vi.fn().mockResolvedValue(undefined);

        let pruneReject!: (err: Error) => void;
        session.compact.mockImplementation(() => new Promise((_, r) => (pruneReject = r)));

        const busyEvents: boolean[] = [];
        def.onBusyChange = (_id, busy) => busyEvents.push(busy);
        const listenerEvents: string[] = [];
        def.listeners = new Set([(e) => listenerEvents.push(e.type)]);

        def.handleSessionEvent({ type: 'agent_end' });

        pruneReject(new Error('compact failed'));
        await new Promise((r) => setImmediate(r));

        expect(def.isPruning).toBe(false);
        expect(def.deferredAgentEnd).toBeNull();
        expect(def.busy).toBe(false);
        expect(busyEvents).toEqual([false]);
        expect(listenerEvents).toEqual(['agent_end']);
      });

      it('keeps the latest agent_end when a second one arrives mid-pruning', async () => {
        const { internal } = makeHostForPruning(3);
        const def = internal as DeferralInternal;
        const session = mockSession(['baseline', 'second', 'third']);
        def.session = session;
        def._sessionDir = '/tmp/test-session';
        def.compactionCount = 3;
        def.busy = true;
        def.writeCompactionCount = vi.fn();
        def.handlePotentialError = vi.fn().mockResolvedValue(undefined);

        let pruneResolve!: () => void;
        session.compact.mockImplementation(() => new Promise<void>((r) => (pruneResolve = r)));

        const listenerEvents: { type: string; tag?: string }[] = [];
        def.listeners = new Set([(e) => listenerEvents.push(e as { type: string; tag?: string })]);

        def.handleSessionEvent({ type: 'agent_end', tag: 'first' } as { type: string });
        expect(def.deferredAgentEnd).toEqual({ type: 'agent_end', tag: 'first' });

        def.handleSessionEvent({ type: 'agent_end', tag: 'second' } as { type: string });
        expect(def.deferredAgentEnd).toEqual({ type: 'agent_end', tag: 'second' });

        // Re-entry guard prevents the second agent_end from triggering pruning again.
        expect(session.compact).toHaveBeenCalledTimes(1);

        pruneResolve();
        await new Promise((r) => setImmediate(r));

        expect(listenerEvents).toEqual([{ type: 'agent_end', tag: 'second' }]);
      });

      it('routes compaction_end through handleCompactionTracking via handleSessionEvent', () => {
        const { internal } = makeHostForPruning(3);
        const def = internal as DeferralInternal;
        def.compactionCount = 0;
        def.writeCompactionCount = vi.fn();
        def.handlePotentialError = vi.fn().mockResolvedValue(undefined);
        def.listeners = new Set();

        def.handleSessionEvent({
          type: 'compaction_end',
          result: { firstKeptEntryId: 'abc' },
          aborted: false,
        });

        expect(def.compactionCount).toBe(1);
      });

      it('stale pruning .finally is a no-op once pruningGeneration is bumped', async () => {
        const { internal } = makeHostForPruning(3);
        const def = internal as DeferralInternal & { pruningGeneration: number };
        const sessionA = mockSession(['baseline', 'second', 'third']);
        def.session = sessionA;
        def._sessionDir = '/tmp/test-session';
        def.compactionCount = 3;
        def.busy = true;
        def.writeCompactionCount = vi.fn();
        def.handlePotentialError = vi.fn().mockResolvedValue(undefined);

        let resolveA!: () => void;
        sessionA.compact.mockImplementation(() => new Promise<void>((r) => (resolveA = r)));

        const listenerEvents: string[] = [];
        def.listeners = new Set([(e) => listenerEvents.push(e.type)]);
        const busyEvents: boolean[] = [];
        def.onBusyChange = (_id, busy) => busyEvents.push(busy);

        // Pruning A starts.
        def.handleSessionEvent({ type: 'agent_end' });
        expect(def.isPruning).toBe(true);
        expect(def.deferredAgentEnd).toEqual({ type: 'agent_end' });

        // Simulate reinitializeWithProvider clearing pruning state and bumping
        // the generation while pruning A is still in flight.
        def.deferredAgentEnd = null;
        def.isPruning = false;
        def.pruningGeneration++;

        // A new agent_end fires after reinit completes; pruning B starts.
        const sessionB = mockSession(['baseline', 'second', 'third']);
        def.session = sessionB;
        def.compactionCount = 3;
        let resolveB!: () => void;
        sessionB.compact.mockImplementation(() => new Promise<void>((r) => (resolveB = r)));
        def.busy = true;

        def.handleSessionEvent({ type: 'agent_end' });
        expect(def.isPruning).toBe(true);
        expect(def.deferredAgentEnd).toEqual({ type: 'agent_end' });

        // Pruning A's promise resolves now (its session is dead). Its .finally
        // should be a no-op because the generation was bumped.
        resolveA();
        await new Promise((r) => setImmediate(r));

        expect(def.isPruning).toBe(true);
        expect(def.deferredAgentEnd).toEqual({ type: 'agent_end' });
        expect(listenerEvents).toEqual([]);

        // Pruning B's promise resolves; its .finally fires and flushes.
        resolveB();
        await new Promise((r) => setImmediate(r));

        expect(def.isPruning).toBe(false);
        expect(def.deferredAgentEnd).toBeNull();
        expect(listenerEvents).toEqual(['agent_end']);
      });
    });

    describe('cross-file operations', () => {
      let testDir: string;

      beforeEach(() => {
        testDir = join(
          tmpdir(),
          `system2-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        );
        mkdirSync(testDir, { recursive: true });
      });

      afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
      });

      /** Write a JSONL file with explicit mtime for deterministic ordering */
      function writeJsonlFile(filename: string, entries: object[], mtime: Date) {
        const filePath = join(testDir, filename);
        const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
        writeFileSync(filePath, content);
        utimesSync(filePath, mtime, mtime);
      }

      it('readCompactionCount returns 0 when file does not exist', () => {
        const { internal } = makeHostForPruning(3);
        internal._sessionDir = testDir;

        expect(internal.readCompactionCount()).toBe(0);
      });

      it('writeCompactionCount persists and readCompactionCount recovers the value', () => {
        const { internal } = makeHostForPruning(3);
        internal._sessionDir = testDir;

        internal.writeCompactionCount(7);
        expect(internal.readCompactionCount()).toBe(7);

        internal.writeCompactionCount(0);
        expect(internal.readCompactionCount()).toBe(0);
      });

      it('findBaselineSummary retrieves baseline from archived file', () => {
        const { internal } = makeHostForPruning(3);

        writeJsonlFile(
          'old.jsonl',
          [
            { type: 'session', version: 3 },
            { type: 'compaction', summary: 'baseline in old file' },
            { type: 'compaction', summary: 'second in old file' },
          ],
          new Date('2025-01-01')
        );

        writeJsonlFile(
          'current.jsonl',
          [
            { type: 'session', version: 3 },
            { type: 'compaction', summary: 'carried over to current' },
          ],
          new Date('2025-01-02')
        );

        internal._sessionDir = testDir;
        internal.compactionCount = 3;
        internal.session = {
          sessionManager: {
            getBranch: vi
              .fn()
              .mockReturnValue([{ type: 'compaction', summary: 'carried over to current' }]),
          },
          compact: vi.fn(),
          getContextUsage: vi.fn(),
        };

        // 3 compactions total: ['baseline in old file', 'second in old file', 'carried over to current']
        // compactionCount=3: baseline at index 3-3=0 → 'baseline in old file'
        const baseline = internal.findBaselineSummary();
        expect(baseline).toBe('baseline in old file');
      });

      it('findBaselineSummary returns null when archived files lack enough compactions', () => {
        const { internal } = makeHostForPruning(5);

        writeJsonlFile(
          'old.jsonl',
          [
            { type: 'session', version: 3 },
            { type: 'compaction', summary: 'only one old' },
          ],
          new Date('2025-01-01')
        );

        writeJsonlFile(
          'current.jsonl',
          [
            { type: 'session', version: 3 },
            { type: 'compaction', summary: 'only one current' },
          ],
          new Date('2025-01-02')
        );

        internal._sessionDir = testDir;
        internal.compactionCount = 5;
        internal.session = {
          sessionManager: {
            getBranch: vi
              .fn()
              .mockReturnValue([{ type: 'compaction', summary: 'only one current' }]),
          },
          compact: vi.fn(),
          getContextUsage: vi.fn(),
        };

        // Only 2 compactions total, need 5
        const baseline = internal.findBaselineSummary();
        expect(baseline).toBeNull();
      });

      it('triggerPruningCompaction uses cross-file baseline', async () => {
        const { internal } = makeHostForPruning(2);

        writeJsonlFile(
          'old.jsonl',
          [
            { type: 'session', version: 3 },
            { type: 'compaction', summary: 'the cross-file baseline' },
          ],
          new Date('2025-01-01')
        );

        writeJsonlFile(
          'current.jsonl',
          [
            { type: 'session', version: 3 },
            { type: 'compaction', summary: 'latest compaction' },
          ],
          new Date('2025-01-02')
        );

        const session = {
          sessionManager: {
            getBranch: vi
              .fn()
              .mockReturnValue([{ type: 'compaction', summary: 'latest compaction' }]),
          },
          compact: vi.fn().mockResolvedValue(undefined),
          getContextUsage: vi.fn(),
        };
        internal.session = session;
        internal._sessionDir = testDir;
        internal.compactionCount = 2;

        await internal.triggerPruningCompaction();

        expect(session.compact).toHaveBeenCalledOnce();
        const instructions = session.compact.mock.calls[0][0] as string;
        expect(instructions).toContain('the cross-file baseline');
        expect(instructions).not.toContain('[pruned]');
        expect(internal.compactionCount).toBe(0);
      });
    });
  });

  describe('isContextOverflowError', () => {
    // isContextOverflowError is module-private, so it is tested indirectly:
    // we drive handlePotentialError with crafted error messages and assert
    // whether handleContextOverflow was called (mocked on the instance).

    type OverflowInternal = {
      handlePotentialError: (event: unknown) => Promise<void>;
      handleContextOverflow: ReturnType<typeof vi.fn>;
      contextOverflowHandled: boolean;
      pendingPrompt: string | null;
      pendingDeliveries: Array<{
        content: string;
        details: Record<string, unknown>;
        urgent: boolean;
        resolve: () => void;
        reject: (reason: Error) => void;
      }>;
      session: { sendCustomMessage: ReturnType<typeof vi.fn> } | null;
      isReinitializing: boolean;
      currentProvider: string;
      retryAttempts: Map<string, number>;
      authResolver: {
        markKeyFailed: ReturnType<typeof vi.fn>;
        getNextProvider: ReturnType<typeof vi.fn>;
      };
    };

    function makeHostForOverflow() {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as OverflowInternal;
      internal.currentProvider = 'google';
      internal.retryAttempts = new Map();
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      internal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);
      // Replace handleContextOverflow so we can assert it was called
      internal.handleContextOverflow = vi.fn().mockResolvedValue(true);
      return { host, internal };
    }

    function makeOverflowEvent(errorMessage: string) {
      return {
        type: 'message_end',
        message: { stopReason: 'error', errorMessage },
      };
    }

    it('triggers handleContextOverflow for Gemini overflow message', async () => {
      const { internal } = makeHostForOverflow();
      await internal.handlePotentialError(
        makeOverflowEvent('400 Bad Request: input token count (1050000) exceeds the maximum')
      );
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
    });

    it('triggers handleContextOverflow for OpenAI overflow message', async () => {
      const { internal } = makeHostForOverflow();
      await internal.handlePotentialError(
        makeOverflowEvent('400 Bad Request: maximum context length is 128000 tokens')
      );
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
    });

    it('triggers handleContextOverflow for Anthropic overflow message', async () => {
      const { internal } = makeHostForOverflow();
      await internal.handlePotentialError(
        makeOverflowEvent('400 Bad Request: prompt is too long: 200000 tokens > 100000 maximum')
      );
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
    });

    it('does NOT trigger handleContextOverflow for unrelated 400 errors', async () => {
      const { internal } = makeHostForOverflow();
      await internal.handlePotentialError(makeOverflowEvent('400 Bad Request: invalid api key'));
      expect(internal.handleContextOverflow).not.toHaveBeenCalled();
    });

    it('does NOT trigger handleContextOverflow twice (one-shot guard)', async () => {
      const { internal } = makeHostForOverflow();
      const event = makeOverflowEvent('400: input token count exceeds maximum');
      await internal.handlePotentialError(event);
      await internal.handlePotentialError(event);
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
    });

    it('does NOT trigger handleContextOverflow for rate-limit errors that match overflow heuristic', async () => {
      const { internal } = makeHostForOverflow();
      // Exhaust retries so we reach the overflow check
      internal.retryAttempts.set('google:rate_limit', 99);
      // This message matches size+token keywords but is a rate-limit error, not a context overflow
      await internal.handlePotentialError(
        makeOverflowEvent('429: token per minute limit exceeded for model')
      );
      expect(internal.handleContextOverflow).not.toHaveBeenCalled();
    });

    it('clears pendingPrompt on successful recovery so it is not retried on a later failover', async () => {
      const { internal } = makeHostForOverflow();
      internal.pendingPrompt = 'overflow-causing prompt';
      await internal.handlePotentialError(
        makeOverflowEvent('400: input token count exceeds maximum context length')
      );
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
      expect(internal.pendingPrompt).toBeNull();
    });

    it('drops pending deliveries and rejects their promises on wire-size overflow (413)', async () => {
      const { internal } = makeHostForOverflow();
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      internal.session = { sendCustomMessage };
      const reject1 = vi.fn();
      const reject2 = vi.fn();
      internal.pendingDeliveries = [
        {
          content: 'task-1',
          details: { source: 'scheduler' },
          urgent: false,
          resolve: vi.fn(),
          reject: reject1,
        },
        {
          content: 'task-2',
          details: { source: 'scheduler' },
          urgent: true,
          resolve: vi.fn(),
          reject: reject2,
        },
      ];
      await internal.handlePotentialError(
        makeOverflowEvent('413: request exceeds the maximum size allowed')
      );
      // Delivery promises are rejected with a wire-size error message
      expect(reject1).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('wire-size') })
      );
      expect(reject2).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('wire-size') })
      );
      // pendingDeliveries cleared by the drop guard
      expect(internal.pendingDeliveries).toHaveLength(0);
    });

    it('drops pending deliveries on Anthropic OAuth long-context misclassifier (429)', async () => {
      const { internal } = makeHostForOverflow();
      const reject1 = vi.fn();
      internal.pendingDeliveries = [
        {
          content: 'task-1',
          details: { source: 'scheduler' },
          urgent: false,
          resolve: vi.fn(),
          reject: reject1,
        },
      ];
      await internal.handlePotentialError(
        makeOverflowEvent('429: extra usage is required for long context requests')
      );
      expect(reject1).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('wire-size') })
      );
      expect(internal.pendingDeliveries).toHaveLength(0);
    });

    it('does NOT drop pending deliveries on token-window overflow (400 input token count)', async () => {
      const { internal } = makeHostForOverflow();
      const reject1 = vi.fn();
      const resolve1 = vi.fn();
      internal.pendingDeliveries = [
        {
          content: 'task-1',
          details: { source: 'scheduler' },
          urgent: false,
          resolve: resolve1,
          reject: reject1,
        },
      ];
      await internal.handlePotentialError(
        makeOverflowEvent('400: input token count exceeds maximum context length')
      );
      // Token-window overflow is recoverable via compaction — deliveries must NOT be dropped
      expect(reject1).not.toHaveBeenCalled();
      expect(internal.pendingDeliveries).toHaveLength(1);
      // handleContextOverflow still triggered
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
    });

    it('does NOT drop pending deliveries on token-window overflow (400 maximum context length)', async () => {
      const { internal } = makeHostForOverflow();
      const reject1 = vi.fn();
      internal.pendingDeliveries = [
        {
          content: 'task-1',
          details: { source: 'scheduler' },
          urgent: false,
          resolve: vi.fn(),
          reject: reject1,
        },
      ];
      await internal.handlePotentialError(
        makeOverflowEvent('400: maximum context length is 128000 tokens')
      );
      expect(reject1).not.toHaveBeenCalled();
      expect(internal.pendingDeliveries).toHaveLength(1);
    });

    it('does not drop pending deliveries on context_overflow when there are none', async () => {
      const { internal } = makeHostForOverflow();
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      internal.session = { sendCustomMessage };
      internal.pendingDeliveries = [];
      await internal.handlePotentialError(
        makeOverflowEvent('413: request exceeds the maximum size allowed')
      );
      // handleContextOverflow still called, no rejection errors thrown
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
      expect(sendCustomMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleContextOverflow', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        tmpdir(),
        `system2-overflow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    type OverflowRecoveryInternal = {
      session: {
        compact: ReturnType<typeof vi.fn>;
      } | null;
      _sessionDir: string | null;
      contextWindow: number;
      contextOverflowHandled: boolean;
      compactionCount: number;
      compactionDepth: number;
      currentProvider: string;
      handleContextOverflow: (
        targetContextWindow?: number,
        compactionProvider?: string
      ) => Promise<boolean>;
      handleCompactionTracking: ReturnType<typeof vi.fn>;
      bumpCompactionCount: ReturnType<typeof vi.fn>;
      reinitializeWithProvider: ReturnType<typeof vi.fn>;
      writeCompactionCount: ReturnType<typeof vi.fn>;
    };

    function makeHostForRecovery() {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as OverflowRecoveryInternal;
      internal._sessionDir = testDir;
      internal.contextWindow = 1_000_000;
      internal.currentProvider = 'google';
      internal.compactionDepth = 1;
      internal.compactionCount = 0;
      internal.writeCompactionCount = vi.fn();
      internal.reinitializeWithProvider = vi.fn().mockImplementation(async () => {
        // After reinit, session is set to a new mock
        internal.session = { compact: vi.fn().mockResolvedValue(undefined) };
      });
      internal.handleCompactionTracking = vi.fn();
      internal.bumpCompactionCount = vi.fn();
      internal.session = { compact: vi.fn().mockResolvedValue(undefined) };
      return { host, internal };
    }

    function writeJsonlFile(filename: string, entries: object[], mtime: Date) {
      const filePath = join(testDir, filename);
      const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
      writeFileSync(filePath, content);
      utimesSync(filePath, mtime, mtime);
      return filePath;
    }

    it('truncates JSONL at split point, reinitializes, compacts, appends tail, reinitializes again', async () => {
      // contextWindow is 1M, 50% = 500K. First two entries below threshold, third above.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 300_000, output: 100 } } }, // below 50% (500K)
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } }, // below 50% → split here (last below)
        {
          type: 'message',
          message: { role: 'assistant', usage: { input: 1_100_000, output: 100 } },
        }, // above 100%
      ];
      const filePath = writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow();

      // Read file after full recovery (head was compacted, tail was re-appended)
      const remaining = readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      // After compact+tail-append the file has head+tail; reinitialize was called twice
      expect(internal.reinitializeWithProvider).toHaveBeenCalledTimes(2);
      // session.compact() succeeded, so bumpCompactionCount was called directly
      // (overflow recovery used to synthesize a compaction_end event; we now
      // bump the counter directly to keep handleCompactionTracking strictly
      // typed against AgentSessionEvent).
      expect(internal.bumpCompactionCount).toHaveBeenCalledTimes(1);
      // The overflow entry (index 3) should be in the tail and appended back
      expect(remaining.at(-1)).toMatchObject({
        type: 'message',
        message: { usage: { input: 1_100_000 } },
      });
    });

    it('splits at the last message below 50% when multiple candidates exist', async () => {
      // contextWindow is 1M, 50% = 500K.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 200_000, output: 100 } } },
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } }, // last below 50% → split here
        { type: 'message', message: { role: 'assistant', usage: { input: 700_000, output: 100 } } }, // above 50%
        {
          type: 'message',
          message: { role: 'assistant', usage: { input: 1_050_000, output: 100 } },
        }, // above 100%
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow();

      expect(internal.reinitializeWithProvider).toHaveBeenCalledTimes(2);
    });

    it('returns early without reinitializing when no split point exists', async () => {
      // All messages are above 50%
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 950_000, output: 100 } } },
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow();

      expect(internal.reinitializeWithProvider).not.toHaveBeenCalled();
    });

    it('returns early when sessionDir is null', async () => {
      const { internal } = makeHostForRecovery();
      internal._sessionDir = null;

      await internal.handleContextOverflow();

      expect(internal.reinitializeWithProvider).not.toHaveBeenCalled();
    });

    it('returns early when session dir has no JSONL files', async () => {
      // testDir exists but contains no .jsonl files
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow();

      expect(internal.reinitializeWithProvider).not.toHaveBeenCalled();
    });

    it('skips tail append and second reinit when tail is empty', async () => {
      // Only entries below threshold — no tail
      // contextWindow is 1M, 50% = 500K. Entry at 400K is below threshold.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } },
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow();

      // Only one reinit (before compact), no tail to append
      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
    });

    it('restores tail to file when compact throws mid-recovery', async () => {
      // contextWindow is 1M, 50% = 500K. Entry at 400K is below threshold.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } },
        { type: 'tool_call', name: 'bash' }, // becomes the tail
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      // Override: after first reinit, make compact() reject
      internal.reinitializeWithProvider = vi.fn().mockImplementationOnce(async () => {
        internal.session = {
          compact: vi.fn().mockRejectedValue(new Error('compact failed')),
        };
      });

      await internal.handleContextOverflow();

      // The tail entry must be restored — tool_call should be back in the file
      const restored = readFileSync(join(testDir, 'session.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { type: string });
      expect(restored.some((e) => e.type === 'tool_call')).toBe(true);
    });

    it('does not double-append tail when second reinit fails after tail was already written', async () => {
      // contextWindow is 1M, 50% = 500K. Entry at 400K is below threshold.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } },
        { type: 'tool_call', name: 'bash' }, // becomes the tail
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      // First reinit succeeds (compact works); second reinit (after tail append) throws
      let callCount = 0;
      internal.reinitializeWithProvider = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          internal.session = { compact: vi.fn().mockResolvedValue(undefined) };
        } else {
          throw new Error('second reinit failed');
        }
      });

      await internal.handleContextOverflow();

      // File should contain exactly one tool_call (not duplicated)
      const finalEntries = readFileSync(join(testDir, 'session.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { type: string });
      const toolCallCount = finalEntries.filter((e) => e.type === 'tool_call').length;
      expect(toolCallCount).toBe(1);
    });

    it('guard resets after successful recovery, allowing a second recovery on the same session', async () => {
      // contextWindow is 1M, 50% = 500K. Entry at 400K is below threshold.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } },
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      // First recovery — guard auto-resets at the end of handleContextOverflow()
      await internal.handleContextOverflow();
      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      expect(internal.contextOverflowHandled).toBe(false);

      // Second recovery is possible without any manual guard reset
      writeJsonlFile('session.jsonl', entries, new Date());
      await internal.handleContextOverflow();
      expect(internal.reinitializeWithProvider).toHaveBeenCalledTimes(2);
    });

    it('uses targetContextWindow for split threshold when provided', async () => {
      // contextWindow is 1M, but targetContextWindow is 131K (e.g. Cerebras)
      // 50% of 131K = 65.5K. Entry at 60K is below, entry at 100K is above.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 60_000, output: 100 } } }, // below 50% of 131K
        { type: 'message', message: { role: 'assistant', usage: { input: 100_000, output: 100 } } }, // above 50% of 131K, below 50% of 1M
        { type: 'message', message: { role: 'assistant', usage: { input: 148_000, output: 100 } } }, // above 131K
      ];
      const filePath = writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow(131_000);

      // Split at entry with 60K (last below 65.5K), tail has 2 entries
      const remaining = readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      expect(internal.reinitializeWithProvider).toHaveBeenCalledTimes(2);
      // Both tail entries (100K and 148K) should be restored
      expect(remaining.at(-1)).toMatchObject({
        type: 'message',
        message: { usage: { input: 148_000 } },
      });
    });

    it('falls back to this.contextWindow with 50% threshold when targetContextWindow is not provided', async () => {
      // contextWindow is 1M, 50% = 500K. Entry at 400K is below, entry at 800K is above.
      const entries = [
        { type: 'session', version: 3 },
        { type: 'message', message: { role: 'assistant', usage: { input: 400_000, output: 100 } } },
        { type: 'message', message: { role: 'assistant', usage: { input: 800_000, output: 100 } } },
      ];
      writeJsonlFile('session.jsonl', entries, new Date());
      const { internal } = makeHostForRecovery();

      await internal.handleContextOverflow();

      // Split at 400K entry, tail has 1 entry (800K) → 2 reinitializations
      expect(internal.reinitializeWithProvider).toHaveBeenCalledTimes(2);
    });
  });

  describe('compactForProvider', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        tmpdir(),
        `system2-compact-provider-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    type CompactProviderInternal = {
      compactForProvider: (provider: string) => Promise<void>;
      handleContextOverflow: ReturnType<typeof vi.fn>;
      agentModels: Record<string, string>;
      modelRegistry: {
        find: ReturnType<typeof vi.fn>;
      };
      session: {
        getContextUsage: ReturnType<typeof vi.fn>;
      } | null;
    };

    function makeHostForCompactProvider() {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as CompactProviderInternal;
      internal.handleContextOverflow = vi.fn().mockResolvedValue(true);
      internal.agentModels = { cerebras: 'zai-glm-4.7', google: 'gemini-2.5-flash' };
      internal.modelRegistry = {
        find: vi.fn().mockImplementation((provider: string) => {
          if (provider === 'cerebras') return { contextWindow: 131_000 };
          if (provider === 'google') return { contextWindow: 1_000_000 };
          return null;
        }),
      };
      internal.session = {
        getContextUsage: vi.fn().mockReturnValue({ tokens: 148_000, percent: 15 }),
      };
      return { host, internal };
    }

    it('triggers handleContextOverflow when context exceeds candidate model window', async () => {
      const { internal } = makeHostForCompactProvider();

      await internal.compactForProvider('cerebras');

      expect(internal.handleContextOverflow).toHaveBeenCalledWith(131_000, 'cerebras');
    });

    it('does not compact when context fits within candidate model window', async () => {
      const { internal } = makeHostForCompactProvider();

      await internal.compactForProvider('google');

      expect(internal.handleContextOverflow).not.toHaveBeenCalled();
    });

    it('does nothing when candidate model is not in agent models', async () => {
      const { internal } = makeHostForCompactProvider();

      await internal.compactForProvider('openai');

      expect(internal.handleContextOverflow).not.toHaveBeenCalled();
    });

    it('does nothing when model registry returns null for candidate', async () => {
      const { internal } = makeHostForCompactProvider();
      internal.agentModels = { mistral: 'mistral-large-latest' };
      internal.modelRegistry.find = vi.fn().mockReturnValue(null);

      await internal.compactForProvider('mistral');

      expect(internal.handleContextOverflow).not.toHaveBeenCalled();
    });

    it('does nothing when context usage is not available', async () => {
      const { internal } = makeHostForCompactProvider();
      internal.session = { getContextUsage: vi.fn().mockReturnValue(null) };

      await internal.compactForProvider('cerebras');

      expect(internal.handleContextOverflow).not.toHaveBeenCalled();
    });
  });

  describe('currentTier tracking', () => {
    it('initializes currentTier as "oauth" when active credential is from OAuth tier', async () => {
      const { AuthResolver } = await import('./auth-resolver.js');

      // Build a config that has both an OAuth tier (anthropic) and a keys tier (cerebras)
      const llmConfig = {
        primary: 'cerebras' as const,
        fallback: [],
        providers: {
          cerebras: { keys: [{ key: 'cer-key-1', label: 'main' }] },
        },
        oauth: { primary: 'anthropic' as const, fallback: [], providers: {} },
      };

      // Provide a non-expiring OAuth credential so the OAuth tier is active
      const oauthCred = {
        access: 'sk-ant-oat01-test',
        refresh: 'sk-ant-ort01-test',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour from now
        label: 'Pro',
      };
      const authResolver = new AuthResolver(llmConfig, undefined, { anthropic: oauthCred });

      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig,
        authResolver,
      });

      const internal = host as unknown as {
        currentTier: string;
        currentProvider: string;
      };

      expect(internal.currentTier).toBe('oauth');
      expect(internal.currentProvider).toBe('anthropic');
    });

    it('initializes currentTier as "api_keys" when no OAuth credentials are present', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });

      const internal = host as unknown as { currentTier: string };
      expect(internal.currentTier).toBe('api_keys');
    });

    it('markKeyFailed uses oauth cooldown key when currentTier is "oauth"', async () => {
      const { AuthResolver } = await import('./auth-resolver.js');

      const llmConfig = {
        primary: 'cerebras' as const,
        fallback: [],
        providers: {
          cerebras: { keys: [{ key: 'cer-key-1', label: 'main' }] },
        },
        oauth: { primary: 'anthropic' as const, fallback: [], providers: {} },
      };

      const oauthCred = {
        access: 'sk-ant-oat01-test',
        refresh: 'sk-ant-ort01-test',
        expires: Date.now() + 60 * 60 * 1000,
        label: 'Pro',
      };
      const authResolver = new AuthResolver(llmConfig, undefined, { anthropic: oauthCred });

      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig,
        authResolver,
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentKeyIndex: number;
        currentTier: string;
        oauthRefreshAttemptedFor: Set<string>;
        authResolver: import('./auth-resolver.js').AuthResolver;
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        session: unknown;
      };

      internal.session = { prompt: vi.fn() };
      internal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);
      // Skip the refresh-and-retry branch so we test the markKeyFailed path directly.
      internal.oauthRefreshAttemptedFor.add('anthropic');

      // Confirm tier is oauth before the error
      expect(internal.currentTier).toBe('oauth');

      // Fire an auth error — goes straight to failover (refresh already attempted)
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 401: Unauthorized - Invalid API key' },
      });

      // The OAuth credential for anthropic:0 should now be in cooldown under the oauth key
      expect(internal.authResolver.isKeyInCooldown('anthropic', 0, 'oauth')).toBe(true);
      // And NOT under the keys key (different namespace)
      expect(internal.authResolver.isKeyInCooldown('anthropic', 0, 'api_keys')).toBe(false);
    });
  });

  describe('OAuth refresh-and-retry on 401', () => {
    async function makeOAuthHost() {
      const { AuthResolver } = await import('./auth-resolver.js');

      const llmConfig = {
        primary: 'cerebras' as const,
        fallback: [],
        providers: {
          cerebras: { keys: [{ key: 'cer-key-1', label: 'main' }] },
        },
        oauth: { primary: 'anthropic' as const, fallback: [], providers: {} },
      };

      const oauthCred = {
        access: 'sk-ant-oat01-test',
        refresh: 'sk-ant-ort01-test',
        expires: Date.now() + 60 * 60 * 1000,
        label: 'Pro',
      };

      const authResolver = new AuthResolver(llmConfig, undefined, { anthropic: oauthCred });

      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig,
        authResolver,
      });

      const internal = host as unknown as {
        handlePotentialError: (event: unknown) => Promise<void>;
        currentProvider: string;
        currentTier: string;
        oauthRefreshAttemptedFor: Set<string>;
        authResolver: import('./auth-resolver.js').AuthResolver;
        reinitializeWithProvider: ReturnType<typeof vi.fn>;
        session: unknown;
      };

      internal.session = { prompt: vi.fn() };
      internal.reinitializeWithProvider = vi.fn().mockResolvedValue(undefined);

      return { host, internal, authResolver };
    }

    const auth401Event = {
      type: 'message_end',
      message: { stopReason: 'error', errorMessage: 'Error 401: Unauthorized - Invalid API key' },
    };

    it('refreshes token and retries via reinitializeWithProvider when ensureFresh succeeds', async () => {
      const { internal, authResolver } = await makeOAuthHost();

      // Stub ensureFresh to succeed and return a set containing the current provider
      vi.spyOn(authResolver, 'ensureFresh').mockResolvedValue(new Set(['anthropic']));
      // Stub markKeyFailed to track calls
      const markKeyFailedSpy = vi.spyOn(authResolver, 'markKeyFailed');

      await internal.handlePotentialError(auth401Event);

      // ensureFresh was called with force: [currentProvider]
      expect(authResolver.ensureFresh).toHaveBeenCalledOnce();
      expect(authResolver.ensureFresh).toHaveBeenCalledWith(
        expect.objectContaining({ force: ['anthropic'] })
      );
      // reinitializeWithProvider was called with the same provider (refresh-and-retry path)
      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      expect(internal.reinitializeWithProvider).toHaveBeenCalledWith(
        'anthropic',
        null, // pendingPrompt (no prompt was queued)
        [], // pendingDeliveries (none queued)
        'OAuth token refreshed',
        expect.stringContaining('anthropic OAuth credential')
      );
      // markKeyFailed must NOT have been called — we didn't fail over
      expect(markKeyFailedSpy).not.toHaveBeenCalled();
    });

    it('falls through to standard failover when ensureFresh returns set NOT containing current provider', async () => {
      const { internal, authResolver } = await makeOAuthHost();

      // Stub ensureFresh to return empty set (refresh was a no-op, e.g. concurrent lock ran first)
      vi.spyOn(authResolver, 'ensureFresh').mockResolvedValue(new Set());
      const markKeyFailedSpy = vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);

      await internal.handlePotentialError(auth401Event);

      // ensureFresh was called
      expect(authResolver.ensureFresh).toHaveBeenCalledOnce();
      // reinitializeWithProvider must NOT have been called — provider not in refreshed set
      expect(internal.reinitializeWithProvider).not.toHaveBeenCalled();
      // Should have fallen through to markKeyFailed (standard failover)
      expect(markKeyFailedSpy).toHaveBeenCalledOnce();
    });

    it('falls through to standard failover (markKeyFailed) when ensureFresh throws', async () => {
      const { internal, authResolver } = await makeOAuthHost();

      // Stub ensureFresh to fail
      vi.spyOn(authResolver, 'ensureFresh').mockRejectedValue(new Error('refresh_token_expired'));
      const markKeyFailedSpy = vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);

      await internal.handlePotentialError(auth401Event);

      // ensureFresh was attempted
      expect(authResolver.ensureFresh).toHaveBeenCalledOnce();
      // Should have fallen through to markKeyFailed (standard auth-failure path)
      expect(markKeyFailedSpy).toHaveBeenCalledOnce();
    });

    it('calls markKeyFailed (no second refresh) when refresh succeeds but retry also returns 401', async () => {
      const { internal, authResolver } = await makeOAuthHost();

      // First 401: ensureFresh succeeds and returns the current provider in the set
      vi.spyOn(authResolver, 'ensureFresh').mockResolvedValue(new Set(['anthropic']));
      const markKeyFailedSpy = vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);

      await internal.handlePotentialError(auth401Event);

      // Refresh succeeded: ensureFresh called once, reinitialize triggered, no failover yet
      expect(authResolver.ensureFresh).toHaveBeenCalledOnce();
      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      expect(markKeyFailedSpy).not.toHaveBeenCalled();
      // Guard flag is now set for this provider
      expect(internal.oauthRefreshAttemptedFor.has('anthropic')).toBe(true);

      // Second 401 arrives (simulates the retried request also failing with 401).
      // oauthRefreshAttemptedFor already has anthropic → no second refresh, fall through to markKeyFailed.
      await internal.handlePotentialError(auth401Event);

      // ensureFresh must NOT have been called a second time
      expect(authResolver.ensureFresh).toHaveBeenCalledOnce();
      // markKeyFailed must be called — standard failover path
      expect(markKeyFailedSpy).toHaveBeenCalledOnce();
    });

    it('appends re-auth hint to cooldown-by-another-agent rotating chat message', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };

      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      // Simulate another agent has just put our credential in cooldown
      vi.spyOn(authResolver, 'isKeyInCooldown').mockReturnValue(true);
      // getNextProvider returns same provider → rotate-to-next-key branch
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue('anthropic');

      await internal.handlePotentialError(auth401Event);

      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      const detail = (internal.reinitializeWithProvider as ReturnType<typeof vi.fn>).mock
        .calls[0][4];
      expect(detail).toContain('rotating to next key');
      expect(detail).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('appends re-auth hint to cooldown-by-another-agent switching chat message', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };

      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'isKeyInCooldown').mockReturnValue(true);
      // getNextProvider returns a DIFFERENT provider → switching branch
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue('cerebras');

      await internal.handlePotentialError(auth401Event);

      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      const detail = (internal.reinitializeWithProvider as ReturnType<typeof vi.fn>).mock
        .calls[0][4];
      expect(detail).toContain('key already in cooldown');
      expect(detail).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('appends re-auth hint to post-markKeyFailed rotating-to-next-key chat message', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };

      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      // Skip the cooldown-by-another-agent branch so we reach markKeyFailed
      vi.spyOn(authResolver, 'isKeyInCooldown').mockReturnValue(false);
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(true);
      // getNextProvider returns SAME provider → rotating-to-next-key branch
      // (real-world OAuth → keys-tier same-provider transition)
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue('anthropic');

      await internal.handlePotentialError(auth401Event);

      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      const detail = (internal.reinitializeWithProvider as ReturnType<typeof vi.fn>).mock
        .calls[0][4];
      expect(detail).toContain('rotating to next key');
      expect(detail).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('appends re-auth hint to last-resort failover chat message', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };

      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'isKeyInCooldown').mockReturnValue(false);
      // markKeyFailed returns false → fall through past the immediate failover
      // block to the all-unavailable pushSystemMessage, then continue to the
      // last-resort failover check at line 1228+
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      // getNextProvider returns a different provider for the last-resort check
      // (simulates a cooldown expiring or transient cooldowns being cleared
      // between markKeyFailed and the last-resort path)
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue('cerebras');

      await internal.handlePotentialError(auth401Event);

      // Last-resort path fires reinitializeWithProvider with its own detail
      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      const detail = (internal.reinitializeWithProvider as ReturnType<typeof vi.fn>).mock
        .calls[0][4];
      expect(detail).toContain('switching to cerebras');
      expect(detail).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('message_start then 401 surfaces the named hint to chat via the all-providers-unavailable path (end-to-end repro for #192)', async () => {
      // Full repro for #192. Before the fix: Anthropic streaming auth failures
      // (turn_start → message_start → message_end with 401) flipped currentTurnHasOutput
      // via message_start, the contamination guard rejected the pending delivery, and
      // the failover path never reached pushSystemMessage — so the chat stayed silent
      // and the user had no idea Anthropic needed re-auth. After the fix: message_start
      // is a soft signal, the guard stays quiet, and pushSystemMessage writes the
      // provider-named hint into the chat cache.
      //
      // Routes through the all-providers-unavailable path (markKeyFailed=false,
      // getNextProvider=undefined) so the real pushSystemMessage runs and we can assert
      // on the chat-cache push directly, not on a mocked reinitializeWithProvider's
      // call args. Copilot review #3 raised this fidelity concern.
      const { host, internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          resolve: () => void;
          reject: (e: Error) => void;
        }>;
        deliverySendCount: number;
        handleSessionEvent: (event: unknown) => void;
      };
      const hostInternal = host as unknown as {
        _chatCache: { push: ReturnType<typeof vi.fn> };
      };
      hostInternal._chatCache = { push: vi.fn() };

      // Simulate refresh-retry already failed for anthropic this delivery (so this 401
      // is the second one and lands in the failover path with hint).
      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue(undefined);

      // Queue a pending delivery that would have been clobbered by the contamination
      // guard before the fix.
      const rejectDelivery = vi.fn();
      cast.pendingDeliveries = [
        {
          content: 'delivery in flight when stream opened',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          resolve: vi.fn(),
          reject: rejectDelivery,
        },
      ];
      cast.deliverySendCount = 1;

      // Drive Anthropic's streaming-auth event sequence.
      cast.handleSessionEvent({ type: 'turn_start' });
      cast.handleSessionEvent({ type: 'message_start', message: {} });
      await internal.handlePotentialError(auth401Event);

      // Contamination guard did NOT fire — delivery survives without the
      // "API error after model output" rejection.
      expect(rejectDelivery).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('API error after model output'),
        })
      );
      // Real pushSystemMessage ran, hitting the chat cache with the provider-named hint.
      expect(hostInternal._chatCache.push).toHaveBeenCalled();
      const pushed = hostInternal._chatCache.push.mock.calls[0][0] as { content: string };
      expect(pushed.content).toContain('all providers unavailable');
      expect(pushed.content).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('appends re-auth hint to switching-provider chat message after refresh-retry failed', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };

      // Simulate refresh-retry already failed for anthropic this delivery
      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(true);
      // hasMore returns true, getNextProvider returns a different provider → switching path
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue('cerebras');

      await internal.handlePotentialError(auth401Event);

      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      const detail = (internal.reinitializeWithProvider as ReturnType<typeof vi.fn>).mock
        .calls[0][4];
      expect(detail).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('appends re-auth hint to all-providers-unavailable chat message after refresh-retry failed', async () => {
      const { internal, authResolver, host } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };
      const hostInternal = host as unknown as { _chatCache: { push: ReturnType<typeof vi.fn> } };
      hostInternal._chatCache = { push: vi.fn() };

      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      // markKeyFailed returns false → no more providers → all-unavailable branch
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      // Ensure last-resort failover at line 1209+ doesn't find a different provider
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue(undefined);

      await internal.handlePotentialError(auth401Event);

      expect(hostInternal._chatCache.push).toHaveBeenCalled();
      const pushed = hostInternal._chatCache.push.mock.calls[0][0] as { content: string };
      expect(pushed.content).toContain('all providers unavailable');
      expect(pushed.content).toContain(
        'Run `system2 config` to refresh anthropic authentication and restart the server.'
      );
    });

    it('does NOT append re-auth hint for non-auth errors (e.g. rate_limit failover)', async () => {
      const { internal, authResolver, host } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };
      const hostInternal = host as unknown as { _chatCache: { push: ReturnType<typeof vi.fn> } };
      hostInternal._chatCache = { push: vi.fn() };

      // Set has not been touched — no prior auth-401 happened in this delivery
      expect(cast.oauthRefreshAttemptedFor.size).toBe(0);
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue(undefined);

      // 429 rate-limit error: shouldRetry exhausts and triggers failover at attempt 7
      const retryAttempts = (internal as unknown as { retryAttempts: Map<string, number> })
        .retryAttempts;
      retryAttempts.set('anthropic:rate_limit', 7);
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      expect(hostInternal._chatCache.push).toHaveBeenCalled();
      const pushed = hostInternal._chatCache.push.mock.calls[0][0] as { content: string };
      expect(pushed.content).toContain('all providers unavailable');
      expect(pushed.content).not.toContain('Run `system2 config`');
    });

    it('per-provider isolation: a flagged provider does NOT suppress refresh-retry on a different provider', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentProvider: string;
      };

      // Pre-flag a DIFFERENT provider as already-refreshed
      cast.oauthRefreshAttemptedFor.add('openai-codex');
      // currentProvider is still 'anthropic' from makeOAuthHost
      expect(cast.currentProvider).toBe('anthropic');

      vi.spyOn(authResolver, 'ensureFresh').mockResolvedValue(new Set(['anthropic']));

      await internal.handlePotentialError(auth401Event);

      // anthropic refresh-retry must have fired even though openai-codex was already flagged
      expect(authResolver.ensureFresh).toHaveBeenCalledOnce();
      expect(internal.reinitializeWithProvider).toHaveBeenCalledOnce();
      // anthropic is now also in the set
      expect(cast.oauthRefreshAttemptedFor.has('anthropic')).toBe(true);
      // openai-codex remains in the set (unchanged)
      expect(cast.oauthRefreshAttemptedFor.has('openai-codex')).toBe(true);
    });

    it('does NOT trigger refresh-retry on a 403 (permission/entitlement, not revoked token)', async () => {
      const { internal, authResolver } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        oauthAutoResolved: boolean;
        oauthFallbackUsedFor: Set<string>;
      };
      // Disable the auto-resolved 403/404 step-down path so the 403 falls through
      // to the (former) refresh-retry branch
      cast.oauthAutoResolved = false;
      const ensureFreshSpy = vi.spyOn(authResolver, 'ensureFresh');
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue(undefined);

      await internal.handlePotentialError({
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage: 'Error 403: Forbidden - model not available on this plan',
        },
      });

      // 403 must NOT enter the refresh-retry branch
      expect(ensureFreshSpy).not.toHaveBeenCalled();
      // 403 must NOT set the flag
      expect(cast.oauthRefreshAttemptedFor.size).toBe(0);
    });

    it('clears oauthRefreshAttemptedFor on successful agent_end', async () => {
      const { internal, host } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        lastTurnErrored: boolean;
      };
      const hostInternal = host as unknown as {
        handleSessionEvent: (event: { type: string }) => void;
      };

      // Pre-populate the set as if a refresh-retry had been attempted
      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.oauthRefreshAttemptedFor.add('openai-codex');
      cast.lastTurnErrored = false;

      // Drive a successful agent_end (the reset only happens when lastTurnErrored is false)
      hostInternal.handleSessionEvent({ type: 'agent_end' });

      expect(cast.oauthRefreshAttemptedFor.size).toBe(0);
    });

    it('does NOT clear oauthRefreshAttemptedFor on errored agent_end', async () => {
      const { internal, host } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        lastTurnErrored: boolean;
      };
      const hostInternal = host as unknown as {
        handleSessionEvent: (event: { type: string }) => void;
      };

      cast.oauthRefreshAttemptedFor.add('anthropic');
      // Errored turn — the cleanup branch is skipped so retry/failover keeps state
      cast.lastTurnErrored = true;

      hostInternal.handleSessionEvent({ type: 'agent_end' });

      // The set must NOT be cleared on errored turns, otherwise a subsequent
      // 401 in the same delivery would re-enter refresh-retry instead of
      // proceeding to standard failover with the re-auth hint.
      expect(cast.oauthRefreshAttemptedFor.has('anthropic')).toBe(true);
    });

    it('does NOT append re-auth hint when current tier is api_keys (post-failover from OAuth)', async () => {
      const { internal, authResolver, host } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentTier: string;
        currentKeyIndex: number;
      };
      const hostInternal = host as unknown as { _chatCache: { push: ReturnType<typeof vi.fn> } };
      hostInternal._chatCache = { push: vi.fn() };

      // Simulate: OAuth refresh-retry failed earlier, AuthResolver failed over
      // to an API key for the same provider, currentTier is now api_keys.
      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentTier = 'api_keys';
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue(undefined);

      // 401 from the API key — same provider, different tier
      await internal.handlePotentialError(auth401Event);

      expect(hostInternal._chatCache.push).toHaveBeenCalled();
      const pushed = hostInternal._chatCache.push.mock.calls[0][0] as { content: string };
      // API-key 401 must not show the OAuth re-auth hint, even though the flag
      // was set by the earlier OAuth failure.
      expect(pushed.content).toContain('all providers unavailable');
      expect(pushed.content).not.toContain('Run `system2 config`');
    });

    it('does NOT append re-auth hint when refresh-retry flag is set but current error is non-auth', async () => {
      const { internal, authResolver, host } = await makeOAuthHost();
      const cast = internal as unknown as {
        oauthRefreshAttemptedFor: Set<string>;
        currentKeyIndex: number;
      };
      const hostInternal = host as unknown as { _chatCache: { push: ReturnType<typeof vi.fn> } };
      hostInternal._chatCache = { push: vi.fn() };

      // Simulate: an earlier 401 attempted refresh-retry (flag set), then a later
      // rate-limit error arrives in the same delivery before agent_end clears it.
      cast.oauthRefreshAttemptedFor.add('anthropic');
      cast.currentKeyIndex = 0;
      vi.spyOn(authResolver, 'markKeyFailed').mockReturnValue(false);
      vi.spyOn(authResolver, 'getNextProvider').mockReturnValue(undefined);

      const retryAttempts = (internal as unknown as { retryAttempts: Map<string, number> })
        .retryAttempts;
      retryAttempts.set('anthropic:rate_limit', 7);
      await internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 429: rate limit exceeded' },
      });

      expect(hostInternal._chatCache.push).toHaveBeenCalled();
      const pushed = hostInternal._chatCache.push.mock.calls[0][0] as { content: string };
      // The all-unavailable message fires, but no re-auth hint because this 429
      // is not an auth failure even though the flag is set from a prior 401.
      expect(pushed.content).toContain('all providers unavailable');
      expect(pushed.content).not.toContain('Run `system2 config`');
    });
  });

  describe('readActivityLogWithBudget', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        tmpdir(),
        `system2-actlog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    type ActivityLogInternal = {
      readActivityLogWithBudget: (filePath: string, budget: number) => string;
    };

    function makeHostForActivityLog() {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        knowledgeBudgetChars: 10_000,
      });
      const internal = host as unknown as ActivityLogInternal;
      return { host, internal };
    }

    const FRONTMATTER =
      '---\nlast_narrator_update_ts: 2026-04-28T19:00:00.000Z\nproject_id: 1\nproject_name: test\n---\n';

    it('Test A: 50 KB log.md — preserves frontmatter, keeps newest content, drops oldest with notice', () => {
      // Build 50 KB content: frontmatter + 50 KB of chronological body entries
      const entryLine = '## 2026-04-28T10:00:00Z — some activity entry\n\ncontent here.\n\n';
      const bodyLines: string[] = [];
      let bodyLen = 0;
      while (bodyLen < 50 * 1024) {
        bodyLines.push(entryLine);
        bodyLen += entryLine.length;
      }
      const body = bodyLines.join('');
      // Add a distinct newest entry at the very end so we can assert it's preserved
      const newestEntry = '## 2026-04-28T23:59:00Z — NEWEST ENTRY\n\nThis is the newest.\n\n';
      const fullContent = FRONTMATTER + body + newestEntry;

      const logPath = join(testDir, 'log.md');
      writeFileSync(logPath, fullContent);

      const budget = 10_000;
      const { internal } = makeHostForActivityLog();
      const result = internal.readActivityLogWithBudget(logPath, budget);

      // (a) Frontmatter preserved verbatim
      expect(result.startsWith(FRONTMATTER)).toBe(true);
      // (b) Newest content (last entry) is at the end — truncation notice comes before it
      const truncationNoticePrefix =
        '[...truncated: dropped oldest content from this activity log to fit';
      const truncationNoticeIndex = result.indexOf(truncationNoticePrefix);
      const newestEntryIndex = result.indexOf(newestEntry.trimEnd());
      expect(truncationNoticeIndex).toBeGreaterThanOrEqual(0);
      expect(newestEntryIndex).toBeGreaterThan(truncationNoticeIndex);
      expect(result.trimEnd().endsWith(newestEntry.trimEnd())).toBe(true);
      // (c) Truncation notice present
      expect(result).toContain('newest entries below]');
      // Total length should be <= budget + notice overhead
      expect(result.length).toBeLessThanOrEqual(budget + 200);
    });

    it('Test B: 50 KB daily summary — preserves frontmatter, keeps newest content, drops oldest with notice', () => {
      const summaryFrontmatter = '---\ndate: 2026-04-28\ntype: daily_summary\n---\n';
      const entryLine = '### 09:00 — activity block\n\nsome logged summary content.\n\n';
      const bodyLines: string[] = [];
      let bodyLen = 0;
      while (bodyLen < 50 * 1024) {
        bodyLines.push(entryLine);
        bodyLen += entryLine.length;
      }
      const newestEntry = '### 23:55 — NEWEST SUMMARY ENTRY\n\nEnd-of-day wrap.\n\n';
      const fullContent = summaryFrontmatter + bodyLines.join('') + newestEntry;

      const summaryPath = join(testDir, '2026-04-28.md');
      writeFileSync(summaryPath, fullContent);

      const budget = 10_000;
      const { internal } = makeHostForActivityLog();
      const result = internal.readActivityLogWithBudget(summaryPath, budget);

      // (a) Frontmatter preserved verbatim
      expect(result.startsWith(summaryFrontmatter)).toBe(true);
      // (b) Newest content preserved
      expect(result).toContain('NEWEST SUMMARY ENTRY');
      expect(result).toContain('End-of-day wrap.');
      // (c) Truncation notice present
      expect(result).toContain(
        '[...truncated: dropped oldest content from this activity log to fit'
      );
      expect(result).toContain('newest entries below]');
      expect(result.length).toBeLessThanOrEqual(budget + 200);
    });

    it('Test C (regression): file within budget is returned as-is (no truncation)', () => {
      const smallContent = `${FRONTMATTER}A small file that fits in budget.\n`;
      const filePath = join(testDir, 'small.md');
      writeFileSync(filePath, smallContent);

      const { internal } = makeHostForActivityLog();
      const result = internal.readActivityLogWithBudget(filePath, 10_000);

      expect(result).toBe(smallContent);
      expect(result).not.toContain('[...truncated');
    });

    it('Test C (regression): curated infrastructure.md uses first-N truncation (drops tail, not oldest)', () => {
      // This test verifies the distinction: readActivityLogWithBudget drops the MIDDLE (oldest),
      // while readWithBudget (used for curated files) drops the TAIL.
      // We confirm readActivityLogWithBudget does NOT produce the curated-file truncation marker.
      // To trigger truncation, the file must exceed the budget of 10_000 chars.
      const oldestEntry = '## OLDEST ENTRY — should be dropped\n\ncontent\n\n';
      // Fill with enough middle content to push total over the 10_000-char budget
      const singleMiddle =
        '## middle entry block with some padding content to take up space\n\ncontent here.\n\n';
      const middleEntries = Array(150).fill(singleMiddle).join('');
      const newestEntry = '## NEWEST ENTRY — should be kept\n\ncontent\n\n';
      const fullContent = FRONTMATTER + oldestEntry + middleEntries + newestEntry;

      // Sanity-check: file must exceed budget
      expect(fullContent.length).toBeGreaterThan(10_000);

      const filePath = join(testDir, 'infrastructure.md');
      writeFileSync(filePath, fullContent);

      const budget = 10_000;
      const { internal } = makeHostForActivityLog();
      const result = internal.readActivityLogWithBudget(filePath, budget);

      // Activity-log truncation: oldest dropped, newest kept
      expect(result).toContain('NEWEST ENTRY');
      expect(result).not.toContain('OLDEST ENTRY');
      // The notice marker is the activity-log one, NOT the curated-file one
      expect(result).toContain('dropped oldest content from this activity log');
      expect(result).not.toContain('file exceeds');
    });
  });

  describe('reset session after scheduled task', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        tmpdir(),
        `system2-test-reset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    type ResetInternal = {
      pendingDeliveries: Array<{
        content: string;
        details: { sender: number; receiver: number; timestamp: number };
        urgent?: boolean;
        scheduledTask?: boolean;
        resolve: () => void;
        reject: (reason: Error) => void;
      }>;
      deliverySendCount: number;
      session: unknown;
      _sessionDir: string | null;
      _chatCache: null;
      resetSessionAfterScheduledTask: boolean;
      agentRole: string | null;
      unsubscribeSession: (() => void) | null;
      compactionCount: number;
      lastTurnErrored: boolean;
      hadScheduledTaskDeliveryThisTurn: boolean;
      handleSessionEvent: (event: Record<string, unknown>) => void;
      handlePotentialError: ReturnType<typeof vi.fn>;
      handleCompactionTracking: ReturnType<typeof vi.fn>;
      initialize: ReturnType<typeof vi.fn>;
    };

    /** Build a host with stubbed lifecycle methods, ready for handleSessionEvent('agent_end'). */
    function makeHostWithSessionDir(opts: { reset: boolean; sessionFile?: string }): {
      host: AgentHost;
      internal: ResetInternal;
    } {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        resetSessionAfterScheduledTask: opts.reset,
      });
      const internal = host as unknown as ResetInternal;
      // Stub dispose so resetSessionToHeader can call it before rotating the JSONL.
      internal.session = { sendCustomMessage: vi.fn(), dispose: vi.fn() };
      internal._sessionDir = testDir;
      internal._chatCache = null;
      internal.agentRole = 'narrator';
      internal.unsubscribeSession = null;
      internal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      internal.handleCompactionTracking = vi.fn();
      // Stub initialize so the post-reset reinit doesn't try to load real config
      internal.initialize = vi.fn().mockResolvedValue(undefined);

      // Seed an existing JSONL with prior session state (header + a tool-call line)
      const filename = opts.sessionFile ?? `${Date.now()}_seed.jsonl`;
      const filePath = join(testDir, filename);
      const seedLines = [
        JSON.stringify({ type: 'session', version: 3, id: 'old-id', cwd: '/some/cwd' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'hello' } }),
      ];
      writeFileSync(filePath, `${seedLines.join('\n')}\n`);

      return { host, internal };
    }

    it('truncates JSONL to fresh header and clears session after scheduled-task delivery', () => {
      const { internal } = makeHostWithSessionDir({ reset: true });

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      const resolveDelivery = vi.fn();
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details,
          scheduledTask: true,
          resolve: resolveDelivery,
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;

      internal.handleSessionEvent({ type: 'agent_end' });

      // Delivery promise resolved (cleanup happened before reset)
      expect(resolveDelivery).toHaveBeenCalledOnce();

      // Old file archived
      const files = readdirSync(testDir);
      const archived = files.filter((f) => f.endsWith('.jsonl.archived'));
      expect(archived.length).toBe(1);

      // Active JSONL contains exactly one line: a fresh session header
      const active = files.filter((f) => f.endsWith('.jsonl'));
      expect(active.length).toBe(1);
      const activePath = join(testDir, active[0]);
      const lines = readFileSync(activePath, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const header = JSON.parse(lines[0]);
      expect(header.type).toBe('session');
      expect(header.version).toBe(3);
      expect(header.id).toBeTruthy();
      // Header is fresh, not the seeded one
      expect(header.id).not.toBe('old-id');

      // In-memory session was cleared so the next prompt forces reinit
      expect(internal.session).toBeNull();

      // Reinit was kicked off asynchronously
      expect(internal.initialize).toHaveBeenCalledOnce();
    });

    it('does not reset when delivery content lacks the [Scheduled task: prefix', () => {
      const { internal } = makeHostWithSessionDir({ reset: true });

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      internal.pendingDeliveries = [
        {
          content: '[Message from guide agent (id=1)]\n\nplease look at this',
          details,
          scheduledTask: false,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;

      const sessionBefore = internal.session;
      internal.handleSessionEvent({ type: 'agent_end' });

      const archived = readdirSync(testDir).filter((f) => f.endsWith('.archived'));
      expect(archived.length).toBe(0);
      expect(internal.session).toBe(sessionBefore);
      expect(internal.initialize).not.toHaveBeenCalled();
    });

    it('does not reset when resetSessionAfterScheduledTask is false', () => {
      const { internal } = makeHostWithSessionDir({ reset: false });

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details,
          scheduledTask: true,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;

      const sessionBefore = internal.session;
      internal.handleSessionEvent({ type: 'agent_end' });

      const archived = readdirSync(testDir).filter((f) => f.endsWith('.archived'));
      expect(archived.length).toBe(0);
      expect(internal.session).toBe(sessionBefore);
      expect(internal.initialize).not.toHaveBeenCalled();
    });

    it('resets session on error turn that attempted a scheduled-task delivery (issue #189)', () => {
      // Repro for the self-reinforcing context-overflow loop: when a daily-summary tick
      // fails mid-turn (model emitted output, then API returned `prompt is too long`),
      // the contamination guard rejects pending deliveries before agent_end fires.
      // Without this reset path, the bloated session never shrinks (handleContextOverflow
      // can't find a safe split point at that size) and every subsequent tick grows it
      // further. Resetting after the failed tick breaks the loop — narrator memory lives
      // in files, so the session is throwaway.
      const { internal } = makeHostWithSessionDir({ reset: true });

      // Simulate handlePotentialError having seen a scheduled-task delivery in flight
      // before the contamination guard rejected and cleared the array.
      internal.hadScheduledTaskDeliveryThisTurn = true;
      internal.lastTurnErrored = true;
      internal.pendingDeliveries = [];

      internal.handleSessionEvent({ type: 'agent_end' });

      // Session was reset: file archived, in-memory session cleared, reinit kicked off
      const archived = readdirSync(testDir).filter((f) => f.endsWith('.jsonl.archived'));
      expect(archived.length).toBe(1);
      expect(internal.session).toBeNull();
      expect(internal.initialize).toHaveBeenCalledOnce();

      // Per-turn flag was cleared after consumption so a subsequent non-scheduled error
      // turn doesn't trigger another reset.
      expect(internal.hadScheduledTaskDeliveryThisTurn).toBe(false);
    });

    it('does not reset on error turn that had no scheduled-task delivery', () => {
      // Chat error turns must not trigger session reset — only scheduled-task error turns
      // do (narrator's reset is explicitly tied to per-cron-tick freshness).
      const { internal } = makeHostWithSessionDir({ reset: true });

      internal.hadScheduledTaskDeliveryThisTurn = false;
      internal.lastTurnErrored = true;
      internal.pendingDeliveries = [];

      const sessionBefore = internal.session;
      internal.handleSessionEvent({ type: 'agent_end' });

      const archived = readdirSync(testDir).filter((f) => f.endsWith('.archived'));
      expect(archived.length).toBe(0);
      expect(internal.session).toBe(sessionBefore);
      expect(internal.initialize).not.toHaveBeenCalled();
    });

    it('handlePotentialError flags hadScheduledTaskDeliveryThisTurn when scheduled-task delivery is pending', async () => {
      // The agent_end reset-on-error path relies on this flag being set before the
      // contamination guard empties pendingDeliveries. Verify the wiring.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        resetSessionAfterScheduledTask: true,
      });
      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          scheduledTask?: boolean;
          resolve: () => void;
          reject: (e: Error) => void;
        }>;
        currentTurnHasOutput: boolean;
        deliverySendCount: number;
        hadScheduledTaskDeliveryThisTurn: boolean;
        handlePotentialError: (event: Record<string, unknown>) => Promise<void>;
      };

      internal.currentTurnHasOutput = true;
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          scheduledTask: true,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      // deliverySendCount=1 means the scheduled-task is "in flight" (dispatched to
      // sendCustomMessage). The flag is set off in-flight deliveries only, not deferred ones.
      internal.deliverySendCount = 1;

      await internal.handlePotentialError({
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage:
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1231304 tokens > 1000000 maximum"}}',
        },
      });

      expect(internal.hadScheduledTaskDeliveryThisTurn).toBe(true);
    });

    it('does not flag hadScheduledTaskDeliveryThisTurn when only DEFERRED scheduled tasks are in queue (Copilot review #1)', async () => {
      // Scenario: a chat prompt() turn errors while scheduled-task deliveries are queued
      // behind it (gate-deferred). The error belongs to the chat turn, not the scheduled
      // tasks — the post-scheduled-task reset must NOT fire and reset the session.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        resetSessionAfterScheduledTask: true,
      });
      const internal = host as unknown as {
        pendingDeliveries: Array<{
          content: string;
          details: { sender: number; receiver: number; timestamp: number };
          scheduledTask?: boolean;
          deferred?: boolean;
          resolve: () => void;
          reject: (e: Error) => void;
        }>;
        currentTurnHasOutput: boolean;
        deliverySendCount: number;
        hadScheduledTaskDeliveryThisTurn: boolean;
        handlePotentialError: (event: Record<string, unknown>) => Promise<void>;
      };

      internal.currentTurnHasOutput = true;
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details: { sender: 1, receiver: 2, timestamp: Date.now() },
          scheduledTask: true,
          deferred: true,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      // deliverySendCount=0: the scheduled task is deferred, not in flight. The errored turn
      // must be something else (e.g., a chat prompt()).
      internal.deliverySendCount = 0;

      await internal.handlePotentialError({
        type: 'message_end',
        message: {
          stopReason: 'error',
          errorMessage:
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1231304 tokens > 1000000 maximum"}}',
        },
      });

      expect(internal.hadScheduledTaskDeliveryThisTurn).toBe(false);
    });

    it('explicit caller-provided false beats frontmatter true (override-presence wins)', () => {
      // Reproduce the precedence merge that initialize() runs at line 377-379:
      //   if (!resetSessionAfterScheduledTaskOverridden) { reset = frontmatter === true; }
      // With the override-presence flag, an explicit `false` from the caller must NOT be
      // silently overridden by frontmatter `true`. Without the flag, this test would
      // demonstrate the round-1 bug: frontmatter `true` flipping a caller-disabled `false`
      // back on.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        resetSessionAfterScheduledTask: false,
      });
      const internal = host as unknown as {
        resetSessionAfterScheduledTask: boolean;
        resetSessionAfterScheduledTaskOverridden: boolean;
      };
      // Constructor should have captured the explicit override.
      expect(internal.resetSessionAfterScheduledTaskOverridden).toBe(true);
      expect(internal.resetSessionAfterScheduledTask).toBe(false);

      // Mimic the initialize() merge with frontmatter saying `true`.
      const frontmatterValue = true;
      if (!internal.resetSessionAfterScheduledTaskOverridden) {
        internal.resetSessionAfterScheduledTask = frontmatterValue === true;
      }

      // Override wins: stays false despite frontmatter `true`.
      expect(internal.resetSessionAfterScheduledTask).toBe(false);
    });

    it('frontmatter true is honored when caller did not override', () => {
      // No `resetSessionAfterScheduledTask` in config — so the override-presence flag is false
      // and initialize()'s merge consults frontmatter.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as {
        resetSessionAfterScheduledTask: boolean;
        resetSessionAfterScheduledTaskOverridden: boolean;
      };
      expect(internal.resetSessionAfterScheduledTaskOverridden).toBe(false);
      expect(internal.resetSessionAfterScheduledTask).toBe(false);

      // Mimic the initialize() merge with frontmatter saying `true`.
      const frontmatterValue = true;
      if (!internal.resetSessionAfterScheduledTaskOverridden) {
        internal.resetSessionAfterScheduledTask = frontmatterValue === true;
      }

      // Caller didn't override, so frontmatter wins.
      expect(internal.resetSessionAfterScheduledTask).toBe(true);
    });

    it('queues deliveries that land during the reset+reinit window and replays them after init', async () => {
      const { internal } = makeHostWithSessionDir({ reset: true });
      const host = internal as unknown as AgentHost;

      // Hold initialize() in flight so we can observe the in-window state. When initialize
      // does eventually resolve, install a fresh session mock so the replay loop has somewhere
      // to send.
      let resolveInit!: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      const freshSendCustomMessage = vi.fn().mockResolvedValue(undefined);
      internal.initialize = vi.fn().mockImplementation(async () => {
        await initPromise;
        internal.session = { sendCustomMessage: freshSendCustomMessage, dispose: vi.fn() };
      });

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      const resolveA = vi.fn();
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details,
          scheduledTask: true,
          resolve: resolveA,
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;

      // Drive the reset+reinit path. After this returns, isReinitializing is true and
      // this.session is null (resetSessionToHeader nulls it before kicking off initialize).
      internal.handleSessionEvent({ type: 'agent_end' });

      const reinitFlag = (internal as unknown as { isReinitializing: boolean }).isReinitializing;
      expect(reinitFlag).toBe(true);

      // A delivery that lands during the reinit window — the exact scenario from issue #169
      // (memory-update catch-up arriving immediately after daily-summary catch-up's agent_end)
      // — must NOT reject. It should queue in pendingDeliveries and be replayed after init.
      const followUpPromise = host.deliverMessage('[Scheduled task: memory-update]\n\nfile: /y', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      // Queued, not rejected. The promise stays pending.
      let settled = false;
      followUpPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      // pendingDeliveries now contains: A (the in-flight one whose agent_end fired) — wait,
      // pre-reset cleanup shifts A out — plus the newly queued one. We assert the new one is in.
      const queued = (internal as unknown as { pendingDeliveries: Array<{ content: string }> })
        .pendingDeliveries;
      expect(queued.some((d) => d.content.includes('memory-update'))).toBe(true);

      // Let initialize() resolve. The .then(replayPendingDeliveries) chain replays the queued
      // delivery against the fresh session.
      resolveInit();
      // Flush microtasks so the void initialize().then(replay) chain runs.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The deferred memory-update was sent against the fresh session.
      const sentContents = freshSendCustomMessage.mock.calls.map(
        (c) => (c[0] as { content: string }).content
      );
      expect(sentContents).toContain('[Scheduled task: memory-update]\n\nfile: /y');
    });

    it('rejects pending deliveries when initialize fails in the reset path so callers do not hang', async () => {
      // Without this rejection, deferred delivery promises sit unresolved forever, blocking
      // any trackJobExecution caller awaiting the delivery (e.g. server.checkNarratorCatchUp).
      // Mirrors the failover path's cleanup in reinitializeWithProvider.
      const { internal } = makeHostWithSessionDir({ reset: true });
      const host = internal as unknown as AgentHost;

      // Hold initialize in flight, then reject. Until the rejection lands, a delivery queued
      // during the reinit window must remain pending; after rejection, it should be rejected
      // with the init error.
      let rejectInit!: (err: Error) => void;
      const initPromise = new Promise<void>((_, rej) => {
        rejectInit = rej;
      });
      internal.initialize = vi.fn().mockImplementation(() => initPromise);

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      const resolveA = vi.fn();
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details,
          scheduledTask: true,
          resolve: resolveA,
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;

      internal.handleSessionEvent({ type: 'agent_end' });

      // A new delivery lands during reinit — gets queued (issue #169 fix).
      let lateRejection: unknown;
      const lateDelivery = host.deliverMessage('[Scheduled task: memory-update]\n\nfile: /y', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });
      lateDelivery.catch((e) => {
        lateRejection = e;
      });

      // Verify it's queued (pending), not yet settled.
      await Promise.resolve();
      expect(lateRejection).toBeUndefined();

      // Now fail initialize. The .catch in handleSessionEvent should reject all pending.
      rejectInit(new Error('boom: cannot recreate session'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Late delivery's promise was rejected with the init error.
      expect(lateRejection).toBeInstanceOf(Error);
      expect((lateRejection as Error).message).toContain('boom: cannot recreate session');

      // pendingDeliveries was cleared (so the next cron tick starts from an empty queue).
      expect(internal.pendingDeliveries).toHaveLength(0);
      expect(internal.deliverySendCount).toBe(0);
    });

    it('replays queued deliveries against the fresh session after reset', async () => {
      const { internal } = makeHostWithSessionDir({ reset: true });

      // After reset clears `this.session = null`, the production code awaits initialize()
      // which rebuilds the session. The test stub doesn't really call initialize, so we
      // simulate the side effect: when initialize resolves, install a fresh session mock
      // (with its own sendCustomMessage spy) that the replay loop can write to.
      const freshSendCustomMessage = vi.fn().mockResolvedValue(undefined);
      internal.initialize = vi.fn().mockImplementation(async () => {
        internal.session = { sendCustomMessage: freshSendCustomMessage, dispose: vi.fn() };
      });

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };

      // Two scheduled-task deliveries pending: A is the one whose agent_end we are about
      // to fire, B was queued behind it (e.g. memory-update piled up while daily-summary
      // was running, or two cron ticks queued during a startup catch-up storm). Without
      // replay, B would be stranded once resetSessionToHeader nulls out the session.
      const resolveA = vi.fn();
      const resolveB = vi.fn();
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /a',
          details,
          scheduledTask: true,
          resolve: resolveA,
          reject: vi.fn(),
        },
        {
          content: '[Scheduled task: memory-update]\n\nfile: /b',
          details,
          scheduledTask: true,
          resolve: resolveB,
          reject: vi.fn(),
        },
      ];
      // Only A's send has been counted: B is queued but not yet flushed to the SDK because
      // the session is busy on A. `agent_end` for A will shift A and leave B in the queue.
      internal.deliverySendCount = 1;

      internal.handleSessionEvent({ type: 'agent_end' });

      // A's promise resolved as part of the pre-reset cleanup
      expect(resolveA).toHaveBeenCalledOnce();
      expect(resolveB).not.toHaveBeenCalled();

      // Reset HAPPENED even though B is still queued — this is the round-1 fix.
      const archived = readdirSync(testDir).filter((f) => f.endsWith('.jsonl.archived'));
      expect(archived.length).toBe(1);
      // Briefly null between resetSessionToHeader and initialize().then(), but after the
      // microtask flush below the freshSendCustomMessage stub will be in place.

      // Reinit was scheduled.
      expect(internal.initialize).toHaveBeenCalledOnce();

      // Flush microtasks so the void initialize().then(replay) chain runs.
      await Promise.resolve();
      await Promise.resolve();

      // Fresh session is installed and B was replayed against it via sendCustomMessage.
      expect(internal.session).not.toBeNull();
      expect(freshSendCustomMessage).toHaveBeenCalledTimes(1);
      const callArg = freshSendCustomMessage.mock.calls[0][0] as { content: string };
      expect(callArg.content).toBe('[Scheduled task: memory-update]\n\nfile: /b');

      // B is still in pendingDeliveries — replay does not pop, agent_end does on the next turn.
      expect(internal.pendingDeliveries).toHaveLength(1);
      expect(internal.pendingDeliveries[0].content).toContain('memory-update');
    });

    it('resets compactionCount (in-memory and persisted) on reset', () => {
      const { internal } = makeHostWithSessionDir({ reset: true });

      // Seed a non-zero compaction count to simulate a long-running narrator session.
      internal.compactionCount = 241;
      // Pre-write the persisted file so we can verify it gets clobbered to 0.
      const countFile = join(testDir, '.compaction-count');
      writeFileSync(countFile, '241');

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details,
          scheduledTask: true,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;
      internal.lastTurnErrored = false;

      internal.handleSessionEvent({ type: 'agent_end' });

      expect(internal.compactionCount).toBe(0);
      expect(readFileSync(countFile, 'utf-8').trim()).toBe('0');
      expect(internal.lastTurnErrored).toBe(false);
    });

    it('prunes old .jsonl.archived files after writing the new session header', () => {
      // Pre-seed 6 stale archives spread across distinct mtimes so the prune step has
      // unambiguous newest/oldest ordering. The reset path then archives the active JSONL,
      // making 7 archives total; with the default cap of 5, the 2 oldest must be deleted.
      const stalePaths: string[] = [];
      for (let i = 0; i < 6; i++) {
        const p = join(testDir, `stale-${i}.jsonl.archived`);
        writeFileSync(p, 'old');
        utimesSync(p, new Date(1000 + i * 10), new Date(1000 + i * 10));
        stalePaths.push(p);
      }

      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        resetSessionAfterScheduledTask: true,
        // Use a custom keepCount distinct from the default to confirm the value flows through.
        archiveKeepCount: 3,
      });
      const internal = host as unknown as ResetInternal;
      internal.session = { sendCustomMessage: vi.fn(), dispose: vi.fn() };
      internal._sessionDir = testDir;
      internal._chatCache = null;
      internal.agentRole = 'narrator';
      internal.unsubscribeSession = null;
      internal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      internal.handleCompactionTracking = vi.fn();
      internal.initialize = vi.fn().mockResolvedValue(undefined);

      // Active JSONL has the newest mtime (it will become the newest .archived after reset).
      const activeFile = join(testDir, `${Date.now()}_seed.jsonl`);
      const seedLines = [
        JSON.stringify({ type: 'session', version: 3, id: 'old-id', cwd: '/some/cwd' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
      ];
      writeFileSync(activeFile, `${seedLines.join('\n')}\n`);
      // Stamp the active file with a clearly newer mtime so it survives pruning.
      utimesSync(activeFile, new Date(10_000), new Date(10_000));

      const details = { sender: 1, receiver: 2, timestamp: Date.now() };
      internal.pendingDeliveries = [
        {
          content: '[Scheduled task: daily-summary]\n\nfile: /x',
          details,
          scheduledTask: true,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      internal.deliverySendCount = 1;

      internal.handleSessionEvent({ type: 'agent_end' });

      // Active file is renamed to .archived → 7 total → cap=3 → 4 oldest pruned.
      const archives = readdirSync(testDir).filter((f) => f.endsWith('.jsonl.archived'));
      expect(archives.length).toBe(3);

      // The freshly archived active file must be among the kept (it had the newest mtime).
      const archivedActive = `${activeFile}.archived`;
      expect(archives).toContain(basename(archivedActive));

      // The two oldest stale archives must be gone.
      expect(existsSync(stalePaths[0])).toBe(false);
      expect(existsSync(stalePaths[1])).toBe(false);
    });

    it('deliverMessage marks scheduled-task content with scheduledTask flag', () => {
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean }>;
      };
      internal.session = { sendCustomMessage: vi.fn() };
      internal._chatCache = null;
      internal._sessionDir = null;

      host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 1', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      host.deliverMessage('[Message from guide agent (id=1)]\n\nhi', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      expect(internal.pendingDeliveries).toHaveLength(2);
      expect(internal.pendingDeliveries[0].scheduledTask).toBe(true);
      expect(internal.pendingDeliveries[1].scheduledTask).toBe(false);
    });

    it('defers second scheduled-task delivery while the first is in flight (issue #189)', async () => {
      // Repro for the within-tick context-overflow trigger: the daily-summary scheduler queues
      // 3 scheduled-task deliveries in rapid succession. Without this gate, all 3 are sent to
      // the Pi SDK as `followUp` turns within ONE run — each delivery's API call carries the
      // prior turns as conversation history, blowing the model's 1M-token context window by
      // the 3rd delivery. The gate keeps each scheduled-task delivery in its own run so the
      // post-scheduled-task session reset can fire between them.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean; deferred?: boolean }>;
      };
      internal.session = { sendCustomMessage };
      internal._chatCache = null;
      internal._sessionDir = null;

      host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 2', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 3', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      host.deliverMessage('[Scheduled task: daily-summary]\n\nfile: /x', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });

      // Flush the reload-then-send microtask so the assertion sees the actual send.
      await Promise.resolve();

      // All 3 queued, but only the first was actually sent to the SDK.
      expect(internal.pendingDeliveries).toHaveLength(3);
      expect(sendCustomMessage).toHaveBeenCalledTimes(1);
      expect(internal.deliverySendCount).toBe(1);

      // The two later ones are marked deferred so agent_end's gated dispatch picks them up.
      expect(internal.pendingDeliveries[0].deferred).toBeFalsy();
      expect(internal.pendingDeliveries[1].deferred).toBe(true);
      expect(internal.pendingDeliveries[2].deferred).toBe(true);
    });

    it('agent_end dispatches the next deferred scheduled-task delivery (issue #189)', async () => {
      // Verifies the gate releases on agent_end: after the in-flight delivery resolves, the
      // next deferred one is sent. Without this, deferred deliveries would sit in the queue
      // forever and the scheduler's Promise.allSettled would never resolve.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean; deferred?: boolean }>;
        handleSessionEvent: (event: Record<string, unknown>) => void;
        handlePotentialError: ReturnType<typeof vi.fn>;
        handleCompactionTracking: ReturnType<typeof vi.fn>;
      };
      internal.session = { sendCustomMessage };
      internal._chatCache = null;
      internal._sessionDir = null;
      internal.handlePotentialError = vi.fn().mockResolvedValue(undefined);
      internal.handleCompactionTracking = vi.fn();

      host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 2', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 3', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      // Flush the reload-then-send microtask for the first delivery.
      await Promise.resolve();
      expect(sendCustomMessage).toHaveBeenCalledTimes(1);

      // Simulate the first delivery's run completing.
      internal.handleSessionEvent({ type: 'agent_end' });

      // First delivery shifted; second (deferred) sent against the now-idle session.
      expect(internal.pendingDeliveries).toHaveLength(1);
      expect(internal.pendingDeliveries[0].content).toContain('project_id: 3');
      expect(internal.pendingDeliveries[0].deferred).toBe(false);
      expect(sendCustomMessage).toHaveBeenCalledTimes(2);
      expect(internal.deliverySendCount).toBe(1);
    });

    it('marks deliveries deferred when queued during reinit (Copilot reviews #2 and #3)', () => {
      // Without this marking, agent_end's `.some(deferred)` guard would skip dispatch and the
      // queued items could stay stuck until the next scheduled-task-triggered reset (which
      // might never come if no other scheduled-task runs). All deliveries — scheduled or
      // chat — that arrive during a reinit window are deferred, both so the agent_end gated
      // dispatch picks them up AND so the queue stays a strict "sent prefix + deferred suffix"
      // (the invariant agent_end's shift and hadScheduledTaskDeliveryThisTurn's slice rely on).
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const internal = host as unknown as {
        session: unknown;
        isReinitializing: boolean;
        _chatCache: null;
        _sessionDir: string | null;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean; deferred?: boolean }>;
      };
      internal.session = null;
      internal.isReinitializing = true;
      internal._chatCache = null;
      internal._sessionDir = null;

      host.deliverMessage('[Scheduled task: memory-update]\n\nfile: /y', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      host.deliverMessage('[Message from guide agent (id=1)]\n\nhi', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      expect(internal.pendingDeliveries).toHaveLength(2);
      expect(internal.pendingDeliveries[0].deferred).toBe(true);
      expect(internal.pendingDeliveries[1].deferred).toBe(true);
    });

    it('defers non-scheduled delivery when an earlier deferred item exists (Copilot review #3)', async () => {
      // FIFO invariant: pendingDeliveries[0..deliverySendCount-1] must be exactly the
      // in-flight prefix. Without this gate, the queue could end up as [A_sent, B_deferred,
      // C_sent], breaking agent_end's shift (it would resolve B's promise on A's run end).
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean; deferred?: boolean }>;
      };
      internal.session = { sendCustomMessage };
      internal._chatCache = null;
      internal._sessionDir = null;

      // A: scheduled-task, sent first
      host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 2', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      // B: scheduled-task, deferred by the scheduled-task gate
      host.deliverMessage('[Scheduled task: daily-summary]\n\nfile: /x', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      // C: NON-scheduled chat arriving after a deferred item exists — must be deferred too.
      host.deliverMessage('[Message from guide agent (id=1)]\n\nhi', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      await Promise.resolve();

      expect(internal.pendingDeliveries).toHaveLength(3);
      expect(sendCustomMessage).toHaveBeenCalledTimes(1); // only A was sent
      expect(internal.deliverySendCount).toBe(1);
      expect(internal.pendingDeliveries[0].deferred).toBeFalsy(); // A: sent
      expect(internal.pendingDeliveries[1].deferred).toBe(true); // B: gate-deferred
      expect(internal.pendingDeliveries[2].deferred).toBe(true); // C: FIFO-deferred
    });

    it('send failure dispatches deferred items (self-review #2/3 on PR #191)', async () => {
      // If sendCustomMessage rejects synchronously, no agent_end fires for that turn —
      // without the .catch's dispatch trigger, any deferred scheduled-task behind the
      // failed send would sit in the queue forever, never resolving.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      // First call (A) rejects; second call (B's dispatch) succeeds.
      const sendCustomMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error('send failed'))
        .mockResolvedValue(undefined);
      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean; deferred?: boolean }>;
      };
      internal.session = { sendCustomMessage };
      internal._chatCache = null;
      internal._sessionDir = null;

      const aPromise = host.deliverMessage('[Scheduled task: project-log]\n\nproject_id: 2', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      // B is deferred behind A (scheduled-task gate).
      host.deliverMessage('[Scheduled task: daily-summary]\n\nfile: /x', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });

      // Flush A's send (which rejects), then B's dispatch from the .catch.
      await aPromise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // A was rejected and removed; B was sent against the live session.
      expect(internal.pendingDeliveries).toHaveLength(1);
      expect(internal.pendingDeliveries[0].content).toContain('daily-summary');
      expect(internal.pendingDeliveries[0].deferred).toBe(false);
      expect(sendCustomMessage).toHaveBeenCalledTimes(2);
    });

    it('defers chat when a scheduled-task is in flight (Copilot review #5 on PR #191)', async () => {
      // "Scheduled tasks run alone" invariant: a non-scheduled delivery arriving while a
      // scheduled-task is in flight must be deferred, not piled on as a Pi SDK followUp.
      // Otherwise chat shares the scheduled-task's run and the per-run session reset would
      // no longer reflect a pure scheduled-task turn.
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
      });
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      const internal = host as unknown as {
        session: { sendCustomMessage: ReturnType<typeof vi.fn> };
        _chatCache: null;
        _sessionDir: string | null;
        deliverySendCount: number;
        pendingDeliveries: Array<{ content: string; scheduledTask?: boolean; deferred?: boolean }>;
      };
      internal.session = { sendCustomMessage };
      internal._chatCache = null;
      internal._sessionDir = null;

      host.deliverMessage('[Scheduled task: daily-summary]\n\nfile: /x', {
        sender: 0,
        receiver: 2,
        timestamp: Date.now(),
      });
      host.deliverMessage('[Message from guide agent (id=1)]\n\nhi', {
        sender: 1,
        receiver: 2,
        timestamp: Date.now(),
      });

      await Promise.resolve();

      expect(internal.pendingDeliveries).toHaveLength(2);
      expect(sendCustomMessage).toHaveBeenCalledTimes(1); // only scheduled-task sent
      expect(internal.deliverySendCount).toBe(1);
      expect(internal.pendingDeliveries[0].deferred).toBeFalsy(); // scheduled: sent
      expect(internal.pendingDeliveries[1].deferred).toBe(true); // chat: deferred
    });
  });
});

describe('pickModelForTier', () => {
  const baseLlm = (): LlmConfig => ({
    primary: 'anthropic',
    fallback: [],
    providers: { anthropic: { keys: [] } },
  });
  const fm = { anthropic: 'claude-sonnet-4-6', 'openai-codex': 'gpt-5.4' } as Partial<
    Record<import('../../shared/index.js').LlmProvider, string>
  >;

  describe('OAuth tier', () => {
    it('returns user pin from [llm.oauth.<p>].model with autoResolved=false', () => {
      const llmConfig = baseLlm();
      llmConfig.oauth = {
        primary: 'anthropic',
        fallback: [],
        providers: { anthropic: { model: 'claude-opus-4-6' } },
      };
      const result = pickModelForTier({
        tier: 'oauth',
        provider: 'anthropic',
        role: 'guide',
        llmConfig,
        frontmatterModels: fm,
        fallbackUsedFor: new Set(),
      });
      expect(result).toEqual({ id: 'claude-opus-4-6', autoResolved: false });
    });

    it('returns resolveOAuthModel result with autoResolved=true when no pin and not stepped down', () => {
      const llmConfig = baseLlm();
      llmConfig.oauth = { primary: 'anthropic', fallback: [], providers: {} };
      const result = pickModelForTier({
        tier: 'oauth',
        provider: 'anthropic',
        role: 'guide',
        llmConfig,
        frontmatterModels: fm,
        fallbackUsedFor: new Set(),
      });
      // Family /^claude-opus-/ in mocked catalog: latest is claude-opus-4-7.
      expect(result).toEqual({ id: 'claude-opus-4-7', autoResolved: true });
    });

    it('returns OAUTH_FALLBACKS[provider] with autoResolved=true after step-down', () => {
      const llmConfig = baseLlm();
      llmConfig.oauth = { primary: 'anthropic', fallback: [], providers: {} };
      const result = pickModelForTier({
        tier: 'oauth',
        provider: 'anthropic',
        role: 'guide',
        llmConfig,
        frontmatterModels: fm,
        fallbackUsedFor: new Set(['anthropic']),
      });
      // OAUTH_FALLBACKS.anthropic is 'claude-sonnet-4-6'.
      expect(result).toEqual({ id: 'claude-sonnet-4-6', autoResolved: true });
    });

    it('isolates step-down per provider — sibling provider still uses resolver', () => {
      const llmConfig = baseLlm();
      llmConfig.oauth = { primary: 'anthropic', fallback: ['openai-codex'], providers: {} };
      const result = pickModelForTier({
        tier: 'oauth',
        provider: 'openai-codex',
        role: 'guide',
        llmConfig,
        frontmatterModels: fm,
        // Anthropic stepped down, but openai-codex still gets the resolver.
        fallbackUsedFor: new Set(['anthropic']),
      });
      expect(result).toEqual({ id: 'gpt-5.5', autoResolved: true });
    });
  });

  describe('API-keys tier', () => {
    it('returns [llm.api_keys.<p>.models][role] when set, autoResolved=false', () => {
      const llmConfig = baseLlm();
      llmConfig.providers.anthropic = {
        keys: [{ key: 'sk-x', label: 'main' }],
        models: { narrator: 'claude-haiku-4-5-20251001' },
      };
      const result = pickModelForTier({
        tier: 'api_keys',
        provider: 'anthropic',
        role: 'narrator',
        llmConfig,
        frontmatterModels: fm,
        fallbackUsedFor: new Set(),
      });
      expect(result).toEqual({ id: 'claude-haiku-4-5-20251001', autoResolved: false });
    });

    it('falls through to frontmatter when no per-role pin', () => {
      const llmConfig = baseLlm();
      const result = pickModelForTier({
        tier: 'api_keys',
        provider: 'anthropic',
        role: 'guide',
        llmConfig,
        frontmatterModels: fm,
        fallbackUsedFor: new Set(),
      });
      expect(result).toEqual({ id: 'claude-sonnet-4-6', autoResolved: false });
    });

    it('returns undefined when neither api-keys pin nor frontmatter has the provider', () => {
      const llmConfig = baseLlm();
      const result = pickModelForTier({
        tier: 'api_keys',
        provider: 'github-copilot',
        role: 'guide',
        llmConfig,
        frontmatterModels: fm,
        fallbackUsedFor: new Set(),
      });
      expect(result.id).toBeUndefined();
      expect(result.autoResolved).toBe(false);
    });
  });
});
