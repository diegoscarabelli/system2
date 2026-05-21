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
    it('resets streaming state for idle agents', () => {
      useChatStore.setState({ activeAgentId: 1 });

      // Agent is idle (not streaming)
      useChatStore.getState().loadHistory([], 1);

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

    it('preserves streaming state for busy agents', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      // Simulate agent mid-stream with a tool call
      useChatStore.getState().startToolCall('bash', '{"command":"ls"}', 1);
      useChatStore.getState().setStreaming(true, 1);

      // Load history (e.g., on switch back) should preserve streaming state
      useChatStore
        .getState()
        .loadHistory([{ id: 'm1', role: 'assistant', content: 'committed msg', timestamp: 1 }], 1);

      const state = useChatStore.getState().agentStates.get(1);
      // Committed messages are updated
      expect(state?.messages).toHaveLength(1);
      expect(state?.messages[0].content).toBe('committed msg');
      // But streaming state is preserved
      expect(state?.isStreaming).toBe(true);
      expect(state?.currentTurnEvents).toHaveLength(1);
      expect(state?.currentTurnEvents[0].type).toBe('tool_call');
    });

    it('merges existing rows that arrived before the snapshot (no drop on subscribe-then-snapshot race)', () => {
      // On switch_agent the server subscribes to chatCache BEFORE sending the
      // snapshot; if a push lands in between, the UI sees chat_message_added
      // first and then chat_history. Without a merge, loadHistory would
      // overwrite messages and drop the row delivered via appendMessage.
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore
        .getState()
        .appendMessage({ id: 'live-1', role: 'system', content: 'arrived live', timestamp: 2 }, 1);

      useChatStore
        .getState()
        .loadHistory([{ id: 'snap-1', role: 'user', content: 'in snapshot', timestamp: 1 }], 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(2);
      // Snapshot stays at the head (preserves persisted order); the live row
      // that wasn't in the snapshot is appended at the tail.
      expect(state?.messages[0].id).toBe('snap-1');
      expect(state?.messages[1].id).toBe('live-1');
    });

    it('snapshot dedups against existing rows that ARE present in it', () => {
      // The same push can land in BOTH the live event and the subsequent
      // snapshot (id is the same). loadHistory must not duplicate.
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore
        .getState()
        .appendMessage({ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }, 1);

      useChatStore
        .getState()
        .loadHistory([{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }], 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
      expect(state?.messages[0].id).toBe('m1');
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
      useChatStore.getState().startCompaction(1);

      useChatStore.getState().clearAllStreamingState();

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.isStreaming).toBe(false);
      expect(state?.isWaitingForResponse).toBe(false);
      expect(state?.activeThinkingId).toBeNull();
      expect(state?.currentAssistantMessage).toBeNull();
      expect(state?.currentTurnEvents).toHaveLength(0);
      expect(state?.compactionStatus).toBe('idle');
      expect(state?.compactionTimestamp).toBeNull();
    });
  });

  describe('addUserMessage (optimistic local insert)', () => {
    it('inserts the user message and returns its id', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      const id = useChatStore.getState().addUserMessage('hello', 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
      expect(state?.messages[0]).toMatchObject({ role: 'user', content: 'hello', id });
      expect(state?.isWaitingForResponse).toBe(true);
    });

    it('skips the optimistic insert when steering mid-stream', () => {
      // Server flushPartialTurn() pushes the assistant partial to chatCache
      // BEFORE the steering user row, so the persisted order is
      // [assistant_partial, user_steering]. If we inserted the user row
      // locally first, chat_message_added's tail-append would put the
      // assistant partial AFTER the user row in the UI — disagreeing with the
      // persisted view. Skipping the optimistic insert lets both rows arrive
      // via chat_message_added in correct order.
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().setStreaming(true, 1);

      const id = useChatStore.getState().addUserMessage('change direction', 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(0);
      // The id is still returned so Chat.tsx can pass it to the server.
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(state?.isWaitingForResponse).toBe(false);
    });

    it('returns an id even when no agent is selected', () => {
      // Ensures Chat.tsx can pass an id to the WS send regardless of target state.
      useChatStore.setState({ activeAgentId: null });
      const id = useChatStore.getState().addUserMessage('hi');
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('appendMessage (server-driven canonical insert)', () => {
    it('appends a system message from chat_message_added', () => {
      useChatStore.getState().loadHistory([], 1);
      useChatStore.setState({ activeAgentId: 1 });

      const fullContent =
        '401 auth error, switched to google\n\non anthropic, switching to google\n\n401 {...}\n\nRun `system2 config` to refresh anthropic authentication and restart the server.';
      useChatStore
        .getState()
        .appendMessage({ id: 'sys-1', role: 'system', content: fullContent, timestamp: 1 }, 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
      expect(state?.messages[0].content).toBe(fullContent);
      // Tag/body split (rendered by SystemMessageBlock) lives below the first
      // double-newline — the hint must be reachable that way.
      expect(state?.messages[0].content).toContain('Run `system2 config`');
    });

    it('sets isWaitingForResponse when a user row arrives from the wire and the agent is idle', () => {
      // Covers (a) the steering case on the originating tab — local insert
      // skipped, the user row arrives via chat_message_added — and (b) other
      // tabs receiving a user message sent from a sibling tab.
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      useChatStore
        .getState()
        .appendMessage({ id: 'u-1', role: 'user', content: 'hi', timestamp: 1 }, 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
      expect(state?.isWaitingForResponse).toBe(true);
    });

    it('does NOT flip isWaitingForResponse when a user row arrives while already streaming (steering case)', () => {
      // Mid-stream the spinner is driven by isStreaming, not isWaitingForResponse.
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().setStreaming(true, 1);

      useChatStore
        .getState()
        .appendMessage({ id: 'u-1', role: 'user', content: 'steer', timestamp: 1 }, 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.isWaitingForResponse).toBe(false);
    });

    it('dedups by id (originating-tab echo)', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      const id = useChatStore.getState().addUserMessage('hello', 1);
      // Server echoes the user message back with the same id.
      useChatStore
        .getState()
        .appendMessage({ id, role: 'user', content: 'hello', timestamp: 1 }, 1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
    });

    it('clears the streaming draft when a canonical assistant row arrives', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      useChatStore.getState().startThinking(1);
      useChatStore.getState().appendThinkingChunk('analyzing...', 1);
      useChatStore.getState().finishThinking(1);
      useChatStore.getState().startAssistantMessage(1);
      useChatStore.getState().appendAssistantChunk('Here is the answer', 1);

      useChatStore.getState().appendMessage(
        {
          id: 'asst-1',
          role: 'assistant',
          content: 'Here is the answer',
          timestamp: 1,
          turnEvents: [
            {
              type: 'thinking',
              data: { id: 't', content: 'analyzing...', isStreaming: false, timestamp: 1 },
            },
          ],
        },
        1
      );

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(1);
      expect(state?.messages[0].role).toBe('assistant');
      expect(state?.currentAssistantMessage).toBeNull();
      expect(state?.currentTurnEvents).toHaveLength(0);
      expect(state?.activeThinkingId).toBeNull();
    });
  });

  describe('clearAssistantDraft', () => {
    it('clears a no-content turn safely', () => {
      useChatStore.setState({ activeAgentId: 1 });
      useChatStore.getState().loadHistory([], 1);

      useChatStore.getState().startAssistantMessage(1);
      useChatStore.getState().appendAssistantChunk('partial', 1);
      useChatStore.getState().clearAssistantDraft(1);

      const state = useChatStore.getState().agentStates.get(1);
      expect(state?.messages).toHaveLength(0);
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

  describe('setInputDraft (per-agent drafts)', () => {
    it('isolates drafts between agents', () => {
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().loadHistory([], 2);

      useChatStore.getState().setInputDraft('hello A', 1);
      useChatStore.getState().setInputDraft('hello B', 2);

      expect(useChatStore.getState().getAgentState(1).inputDraft).toBe('hello A');
      expect(useChatStore.getState().getAgentState(2).inputDraft).toBe('hello B');
    });

    it('defaults to active agent when agentId is omitted', () => {
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().loadHistory([], 2);
      useChatStore.setState({ activeAgentId: 1 });

      useChatStore.getState().setInputDraft('typed for active');

      expect(useChatStore.getState().getAgentState(1).inputDraft).toBe('typed for active');
      expect(useChatStore.getState().getAgentState(2).inputDraft).toBe('');
    });

    it('clearing a draft on send leaves other agents untouched', () => {
      useChatStore.getState().loadHistory([], 1);
      useChatStore.getState().loadHistory([], 2);
      useChatStore.getState().setInputDraft('half-written A', 1);
      useChatStore.getState().setInputDraft('half-written B', 2);

      // Simulate MessageInput's submit clearing the active agent's draft
      useChatStore.getState().setInputDraft('', 1);

      expect(useChatStore.getState().getAgentState(1).inputDraft).toBe('');
      expect(useChatStore.getState().getAgentState(2).inputDraft).toBe('half-written B');
    });

    it('is a no-op when no agent is active and agentId is omitted', () => {
      // activeAgentId is null (reset in beforeEach)
      useChatStore.getState().setInputDraft('orphan text');

      expect(useChatStore.getState().agentStates.size).toBe(0);
    });
  });
});
