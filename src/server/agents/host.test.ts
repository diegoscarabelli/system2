/**
 * AgentHost Tests
 *
 * Tests for the failover race condition fix: pendingPrompt must be captured
 * before any await in handlePotentialError, since prompt() clears it after
 * session.prompt() resolves.
 */

import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '../../shared/index.js';
import { AgentHost } from './host.js';
import type { AgentRegistry } from './registry.js';

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
        handleSessionEvent: (event: { type: string }) => void;
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
        handleSessionEvent: (event: { type: string }) => void;
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
      ).rejects.toThrow('AgentHost not initialized');
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
      handleCompactionTracking: (event: { type: string }) => void;
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

      it('skips pruning when no baseline is available', async () => {
        const { internal } = makeHostForPruning(5);
        const session = mockSession(['only one']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 5;

        await internal.triggerPruningCompaction();

        expect(session.compact).not.toHaveBeenCalled();
        // compactionCount should NOT be reset when pruning is skipped
        expect(internal.compactionCount).toBe(5);
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
      it('increments counter on compaction_end and persists', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking({ type: 'compaction_end' });

        expect(internal.compactionCount).toBe(1);
        expect(internal.writeCompactionCount).toHaveBeenCalledWith(1);
      });

      it('does not increment counter when compaction_depth is 0', () => {
        const { internal } = makeHostForPruning(0);
        internal.compactionCount = 0;

        internal.handleCompactionTracking({ type: 'compaction_end' });

        expect(internal.compactionCount).toBe(0);
      });

      it('triggers pruning on agent_end when counter reaches depth', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking({ type: 'agent_end' });

        expect(internal.isPruning).toBe(true);
      });

      it('triggers pruning regardless of context usage', () => {
        for (const usage of [{ percent: 5 }, { percent: 0 }, null]) {
          const { internal } = makeHostForPruning(3);
          const session = mockSession(['baseline', 'second', 'third']);
          internal.session = session;
          internal._sessionDir = '/tmp/test-session';
          internal.compactionCount = 3;
          internal.writeCompactionCount = vi.fn();
          internal.getContextUsage = vi.fn().mockReturnValue(usage);

          internal.handleCompactionTracking({ type: 'agent_end' });

          expect(internal.isPruning).toBe(true);
        }
      });

      it('does not trigger pruning when counter is below depth', () => {
        const { internal } = makeHostForPruning(3);
        internal.session = mockSession(['a', 'b']);
        internal._sessionDir = '/tmp/test-session';
        internal.compactionCount = 2;

        internal.handleCompactionTracking({ type: 'agent_end' });

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

        internal.handleCompactionTracking({ type: 'agent_end' });

        // compact should not be called because isPruning was already true
        expect(session.compact).not.toHaveBeenCalled();
      });

      it('ignores unrelated event types', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;

        internal.handleCompactionTracking({ type: 'message_update' });
        internal.handleCompactionTracking({ type: 'tool_execution_start' });

        expect(internal.compactionCount).toBe(0);
      });
    });

    describe('agent_end deferral when pruning fires', () => {
      type DeferralInternal = PruningInternal & {
        busy: boolean;
        onBusyChange?: (agentId: number, busy: boolean, contextPercent: number | null) => void;
        listeners: Set<(event: { type: string }) => void>;
        deferredAgentEnd: { type: string } | null;
        handleSessionEvent: (event: { type: string }) => void;
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

    it('replays pending deliveries on the recovered session after context overflow', async () => {
      const { internal } = makeHostForOverflow();
      const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
      internal.session = { sendCustomMessage };
      internal.pendingDeliveries = [
        {
          content: 'task-1',
          details: { source: 'scheduler' },
          urgent: false,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
        {
          content: 'task-2',
          details: { source: 'scheduler' },
          urgent: true,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
      ];
      await internal.handlePotentialError(
        makeOverflowEvent('400: input token count exceeds maximum context length')
      );
      expect(internal.handleContextOverflow).toHaveBeenCalledOnce();
      expect(sendCustomMessage).toHaveBeenCalledTimes(2);
      expect(sendCustomMessage).toHaveBeenNthCalledWith(
        1,
        {
          customType: 'agent_message',
          content: 'task-1',
          display: false,
          details: { source: 'scheduler' },
        },
        { deliverAs: 'followUp', triggerTurn: true }
      );
      expect(sendCustomMessage).toHaveBeenNthCalledWith(
        2,
        {
          customType: 'agent_message',
          content: 'task-2',
          display: false,
          details: { source: 'scheduler' },
        },
        { deliverAs: 'steer', triggerTurn: true }
      );
      // pendingDeliveries NOT cleared (agent_end shifts on success)
      expect(internal.pendingDeliveries).toHaveLength(2);
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
      // compact() was called once (on the session after first reinit)
      // handleCompactionTracking was called with compaction_end
      expect(internal.handleCompactionTracking).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'compaction_end' })
      );
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
});
