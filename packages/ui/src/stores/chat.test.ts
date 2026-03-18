/**
 * Chat Store Tests
 *
 * Tests for per-agent state isolation and loadHistory resets.
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

  describe('clearAllStreamingState', () => {
    it('resets streaming flags, thinking, currentAssistantMessage, and currentTurnEvents', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().startThinking(1);
      useChatStore.getState().startToolCall('bash', '{}', 1);
      useChatStore.getState().startAssistantMessage(1);
      useChatStore.getState().setStreaming(true, 1);
      useChatStore.getState().setWaitingForResponse(true, 1);

      useChatStore.getState().clearAllStreamingState();

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.isStreaming).toBe(false);
      expect(state?.isWaitingForResponse).toBe(false);
      expect(state?.activeThinkingId).toBeNull();
      expect(state?.currentAssistantMessage).toBeNull();
      expect(state?.currentTurnEvents).toHaveLength(0);
    });
  });

  describe('provider (per-agent state)', () => {
    it('setProvider updates only the specified agent', () => {
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().loadHistory([], 2);

      useChatStore.getState().setProvider('openai', 1);

      expect(useChatStore.getState().getAgentState(1).provider).toBe('openai');
      expect(useChatStore.getState().getAgentState(2).provider).toBeNull();
    });
  });
});
