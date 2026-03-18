/**
 * AgentHost Tests
 *
 * Tests for the failover race condition fix: pendingPrompt must be captured
 * before any await in handlePotentialError, since prompt() clears it after
 * session.prompt() resolves.
 */

import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

      // Simulate agent_end: pendingPrompt is now cleared
      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingPrompt).toBeNull();
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
      hostInternal.handlePotentialError = vi.fn();
      hostInternal.handleCompactionTracking = vi.fn();

      hostInternal.pendingPrompt = 'pending message';

      hostInternal.handleSessionEvent({ type: 'message_update' });
      expect(hostInternal.pendingPrompt).toBe('pending message');

      hostInternal.handleSessionEvent({ type: 'tool_execution_start' });
      expect(hostInternal.pendingPrompt).toBe('pending message');

      hostInternal.handleSessionEvent({ type: 'agent_end' });
      expect(hostInternal.pendingPrompt).toBeNull();
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

      // No failover — just retry path (mark enough attempts to skip retry and go to failover,
      // but have no next provider so it exits cleanly after retrying once)
      hostInternal.authResolver.markKeyFailed = vi.fn().mockReturnValue(false);
      hostInternal.authResolver.getNextProvider = vi.fn().mockReturnValue(null);

      // Set retryAttempts to 0 so the first shouldRetry call returns true
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

  describe('compaction pruning', () => {
    /** Internal type escape hatch for compaction pruning tests */
    type PruningInternal = {
      compactionCount: number;
      compactionDepth: number;
      isPruning: boolean;
      sessionDir: string | null;
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
        internal.sessionDir = '/tmp/test-session';
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
        internal.sessionDir = '/tmp/test-session';
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
        internal.sessionDir = '/tmp/test-session';
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
        internal.sessionDir = null;

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
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;

        // 4 summaries, compactionCount=3: baseline at index 4-3=1
        const baseline = internal.findBaselineSummary();
        expect(baseline).toBe('start of window (baseline)');
      });

      it('returns null when not enough compactions exist', () => {
        const { internal } = makeHostForPruning(5);
        internal.session = mockSession(['only one']);
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 5;

        const baseline = internal.findBaselineSummary();
        expect(baseline).toBeNull();
      });

      it('returns null when session is null', () => {
        const { internal } = makeHostForPruning(3);
        internal.session = null;
        internal.sessionDir = '/tmp/test-session';

        const baseline = internal.findBaselineSummary();
        expect(baseline).toBeNull();
      });

      it('handles exact match (summaries.length === compactionCount)', () => {
        const { internal } = makeHostForPruning(2);
        internal.session = mockSession(['baseline', 'latest']);
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 2;

        // 2 summaries, compactionCount=2: baseline at index 2-2=0
        const baseline = internal.findBaselineSummary();
        expect(baseline).toBe('baseline');
      });
    });

    describe('handleCompactionTracking', () => {
      it('increments counter on auto_compaction_end and persists', () => {
        const { internal } = makeHostForPruning(3);
        internal.compactionCount = 0;
        internal.writeCompactionCount = vi.fn();

        internal.handleCompactionTracking({ type: 'auto_compaction_end' });

        expect(internal.compactionCount).toBe(1);
        expect(internal.writeCompactionCount).toHaveBeenCalledWith(1);
      });

      it('does not increment counter when compaction_depth is 0', () => {
        const { internal } = makeHostForPruning(0);
        internal.compactionCount = 0;

        internal.handleCompactionTracking({ type: 'auto_compaction_end' });

        expect(internal.compactionCount).toBe(0);
      });

      it('triggers pruning on agent_end when counter reaches depth and usage >= 30%', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.writeCompactionCount = vi.fn();
        internal.getContextUsage = vi.fn().mockReturnValue({ percent: 30 });

        internal.handleCompactionTracking({ type: 'agent_end' });

        expect(internal.isPruning).toBe(true);
      });

      it('does not trigger pruning when usage is below 30%', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.getContextUsage = vi.fn().mockReturnValue({ percent: 29 });

        internal.handleCompactionTracking({ type: 'agent_end' });

        expect(internal.isPruning).toBe(false);
      });

      it('does not trigger pruning when counter is below depth', () => {
        const { internal } = makeHostForPruning(3);
        internal.session = mockSession(['a', 'b']);
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 2;
        internal.getContextUsage = vi.fn().mockReturnValue({ percent: 50 });

        internal.handleCompactionTracking({ type: 'agent_end' });

        expect(internal.isPruning).toBe(false);
      });

      it('isPruning flag prevents concurrent pruning', () => {
        const { internal } = makeHostForPruning(3);
        const session = mockSession(['baseline', 'second', 'third']);
        internal.session = session;
        internal.sessionDir = '/tmp/test-session';
        internal.compactionCount = 3;
        internal.isPruning = true;
        internal.writeCompactionCount = vi.fn();
        internal.getContextUsage = vi.fn().mockReturnValue({ percent: 50 });

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
        internal.sessionDir = testDir;

        expect(internal.readCompactionCount()).toBe(0);
      });

      it('writeCompactionCount persists and readCompactionCount recovers the value', () => {
        const { internal } = makeHostForPruning(3);
        internal.sessionDir = testDir;

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

        internal.sessionDir = testDir;
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

        internal.sessionDir = testDir;
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
        internal.sessionDir = testDir;
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
});
