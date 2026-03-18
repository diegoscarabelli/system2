/**
 * Chat Store Tests
 *
 * Tests for per-agent state isolation, dequeue routing, and loadHistory resets.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from './chat';

function resetStore() {
  useChatStore.setState({
    agentStates: new Map(),
    activeAgentId: null,
    activeAgentLabel: null,
    activeAgentRole: null,
    guideAgentId: null,
    isConnected: false,
    provider: null,
  });
}

describe('useChatStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('per-agent state isolation', () => {
    it('updating agent A does not change agent B state reference', () => {
      const store = useChatStore.getState();

      // Initialize both agents
      store.loadHistory([], 1);
      store.loadHistory([], 2);

      const beforeB = useChatStore.getState().agentStates.get(2);

      // Update agent A only
      useChatStore
        .getState()
        .loadHistory([{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }], 1);

      const afterB = useChatStore.getState().agentStates.get(2);

      // Agent B state object should be the same reference (not a new object)
      expect(afterB).toBe(beforeB);
    });

    it('updating agent A does not affect agent B messages', () => {
      const store = useChatStore.getState();

      store.loadHistory([], 1);
      store.loadHistory([{ id: 'b1', role: 'user', content: 'agent B message', timestamp: 1 }], 2);

      useChatStore
        .getState()
        .loadHistory([{ id: 'a1', role: 'user', content: 'agent A message', timestamp: 2 }], 1);

      const stateA = useChatStore.getState().agentStates.get(1);
      const stateB = useChatStore.getState().agentStates.get(2);

      expect(stateA?.messages).toHaveLength(1);
      expect(stateA?.messages[0].content).toBe('agent A message');
      expect(stateB?.messages).toHaveLength(1);
      expect(stateB?.messages[0].content).toBe('agent B message');
    });
  });

  describe('dequeueMessage', () => {
    it('dequeues from the correct agent when agentId is provided explicitly', () => {
      // Set active agent to 1
      useChatStore.setState({ activeAgentId: 1 });

      // Initialize both agents
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().loadHistory([], 2);
      const { agentStates } = useChatStore.getState();
      const existingState = agentStates.get(2);
      if (!existingState) throw new Error('agent 2 state not found');
      const stateForTwo = { ...existingState };
      stateForTwo.messageQueue = [
        { id: 'q1', content: 'for agent 2', isSteering: false, timestamp: 1 },
      ];
      const next = new Map(agentStates);
      next.set(2, stateForTwo);
      useChatStore.setState({ agentStates: next });

      // Dequeue explicitly from agent 2
      const msg = useChatStore.getState().dequeueMessage(2);

      expect(msg?.content).toBe('for agent 2');
      // Active agent 1's queue is untouched
      expect(useChatStore.getState().agentStates.get(1)?.messageQueue).toHaveLength(0);
    });

    it('returns undefined when queue is empty', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      expect(useChatStore.getState().dequeueMessage(1)).toBeUndefined();
    });

    it('returns undefined when agentId is null and no active agent', () => {
      expect(useChatStore.getState().dequeueMessage()).toBeUndefined();
    });
  });

  describe('loadHistory', () => {
    it('sets messages and resets streaming state', () => {
      useChatStore.setState({ activeAgentId: 1 });

      // Simulate an agent mid-stream
      useChatStore.getState().startAssistantMessage(1);
      useChatStore.getState().setStreaming(true, 1);

      // Load history should reset all state
      useChatStore
        .getState()
        .loadHistory([{ id: 'm1', role: 'assistant', content: 'past message', timestamp: 1 }], 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
      expect(state?.isStreaming).toBe(false);
      expect(state?.isWaitingForResponse).toBe(false);
      expect(state?.activeThinkingId).toBeNull();
      expect(state?.currentAssistantMessage).toBeNull();
    });
  });

  describe('provider (global state)', () => {
    it('setProvider updates global provider, not per-agent', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      useChatStore.getState().setProvider('openai');

      // Global provider is set
      expect(useChatStore.getState().provider).toBe('openai');

      // Switching activeAgentId does not affect provider
      useChatStore.setState({ activeAgentId: 2 });
      expect(useChatStore.getState().provider).toBe('openai');
    });
  });
});
