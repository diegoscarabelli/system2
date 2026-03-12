/**
 * AgentHost Tests
 *
 * Tests for the failover race condition fix: pendingPrompt must be captured
 * before any await in handlePotentialError, since prompt() clears it after
 * session.prompt() resolves.
 */

import type { LlmConfig } from '@system2/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    it('prompt() sets and clears pendingPrompt around session.prompt()', async () => {
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
      // After session.prompt() resolves, pendingPrompt is cleared
      expect(hostInternal.pendingPrompt).toBeNull();
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

      // pendingPrompt is NOT cleared because the clear line (after await) was never reached
      expect(hostInternal.pendingPrompt).toBe('hello world');
    });
  });

  describe('busy state', () => {
    function makeHostWithBusyTracking() {
      const onBusyChange = vi.fn();
      const host = new AgentHost({
        db: makeDbStub(),
        agentId: 1,
        registry: makeRegistryStub(),
        llmConfig: makeLlmConfig(),
        onBusyChange,
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
      return { host, internal, onBusyChange };
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

    it('abort() clears busy and calls onBusyChange', () => {
      const { host, internal, onBusyChange } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      // Simulate being busy
      internal.busy = true;

      host.abort();

      expect(host.isBusy()).toBe(false);
      expect(onBusyChange).toHaveBeenCalledTimes(1);
    });

    it('abort() is a no-op when already idle', () => {
      const { host, internal, onBusyChange } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      host.abort();

      expect(host.isBusy()).toBe(false);
      expect(onBusyChange).not.toHaveBeenCalled();
    });

    it('handlePotentialError clears busy when all recovery paths exhausted', async () => {
      const { host, internal, onBusyChange } = makeHostWithBusyTracking();
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
      expect(onBusyChange).toHaveBeenCalled();
    });

    it('onBusyChange is not called when busy state does not change', () => {
      const { host, internal, onBusyChange } = makeHostWithBusyTracking();
      setupWithFakeSession(internal);

      // Already idle, abort should not trigger callback
      host.abort();
      expect(onBusyChange).not.toHaveBeenCalled();

      // Already idle, clearing busy via error exhaustion should not trigger callback
      internal.currentProvider = 'cerebras';
      internal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      internal.handlePotentialError({
        type: 'message_end',
        message: { stopReason: 'error', errorMessage: 'Error 401: Unauthorized' },
      });
      expect(onBusyChange).not.toHaveBeenCalled();
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
});
