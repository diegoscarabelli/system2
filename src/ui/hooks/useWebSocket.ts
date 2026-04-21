/**
 * WebSocket Hook
 *
 * Manages WebSocket connection to the server.
 * Messages sent while an agent is streaming are delivered as steering
 * messages that interrupt the current turn immediately.
 * Routes messages to/from per-agent state via agentId.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ClientMessage, ServerMessage } from '../../shared/index.js';
import { useArtifactStore } from '../stores/artifact';
import { useChatStore } from '../stores/chat';
import { usePushStore } from '../stores/push';

const WS_URL = `ws://${window.location.hostname}:4242`;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const prevAgentRef = useRef<number | null>(null);
  const hasConnectedOnce = useRef(false);

  // Send switch_agent when activeAgentId changes (user-initiated switch via AgentPane)
  useEffect(() => {
    if (
      activeAgentId !== null &&
      prevAgentRef.current !== null &&
      activeAgentId !== prevAgentRef.current
    ) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const msg: ClientMessage = { type: 'switch_agent', agentId: activeAgentId };
        wsRef.current.send(JSON.stringify(msg));
      }
    }
    prevAgentRef.current = activeAgentId;
  }, [activeAgentId]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      const state = useChatStore.getState();
      state.setConnected(true);
      if (hasConnectedOnce.current) {
        // On reconnect, clear stale busy state and bump all version counters
        // so UI panels refetch any changes missed during the disconnect
        const push = usePushStore.getState();
        push.clearAgentBusy();
        push.bumpAll();
      }
      hasConnectedOnce.current = true;
      // Re-subscribe to the active agent if it's not the Guide
      if (
        state.activeAgentId !== null &&
        state.guideAgentId !== null &&
        state.activeAgentId !== state.guideAgentId
      ) {
        const msg: ClientMessage = { type: 'switch_agent', agentId: state.activeAgentId };
        ws.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      const state = useChatStore.getState();

      switch (message.type) {
        case 'thinking_chunk': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid === null) break;
          const agentState = state.agentStates.get(aid);
          if (!agentState?.activeThinkingId && message.content) {
            state.startThinking(aid);
          }
          state.appendThinkingChunk(message.content, aid);
          break;
        }

        case 'thinking_end': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.finishThinking(aid);
          break;
        }

        case 'assistant_chunk': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid === null) break;
          const agentState = state.agentStates.get(aid);
          if (!agentState?.currentAssistantMessage && message.content) {
            state.finishThinking(aid);
            state.startAssistantMessage(aid);
          }
          state.appendAssistantChunk(message.content, aid);
          break;
        }

        case 'assistant_end': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) {
            state.finishThinking(aid);
            state.finishAssistantMessage(aid);
            // Show LLM errors in the chat timeline as collapsible system messages
            if (message.errorMessage) {
              state.addSystemMessage(`LLM error\n\n${message.errorMessage}`, aid);
            }
          }
          break;
        }

        case 'tool_call_start': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.startToolCall(message.name, message.input, aid);
          break;
        }

        case 'tool_call_progress': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.updateToolCallProgress(message.name, message.message, aid);
          break;
        }

        case 'tool_call_end': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.finishToolCall(message.name, message.result, aid);
          break;
        }

        case 'ready_for_input': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) {
            state.setStreaming(false, aid);
            state.setWaitingForResponse(false, aid);
            state.resetCompaction(aid);
          }
          break;
        }

        case 'chat_history': {
          const aid = message.agentId;
          // First chat_history is for the Guide (on initial connect)
          if (state.guideAgentId === null) {
            state.setGuideAgentId(aid);
            if (state.activeAgentId === null) {
              // No agent selected yet — default to Guide
              state.setActiveAgent(aid, 'guide');
            } else if (state.activeAgentId !== aid) {
              // User pre-selected a different agent before history arrived —
              // re-subscribe the server to the correct agent
              const switchMsg: ClientMessage = {
                type: 'switch_agent',
                agentId: state.activeAgentId,
              };
              ws.send(JSON.stringify(switchMsg));
            }
          }
          state.loadHistory(message.messages, aid);
          break;
        }

        case 'user_message_broadcast': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) {
            state.addUserMessage(message.content, message.id, message.timestamp, aid);
          }
          break;
        }

        case 'context_usage': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.setContextPercent(message.percent, aid);
          break;
        }

        case 'artifact': {
          const artifactStore = useArtifactStore.getState();
          if (message.filePath) {
            const existingTab = artifactStore.tabs.find((t) => t.filePath === message.filePath);
            if (existingTab) {
              artifactStore.reloadTab(message.filePath, message.url);
            } else {
              artifactStore.openArtifact(message.url, message.title, message.filePath);
            }
          } else {
            artifactStore.openArtifact(message.url, message.title);
          }
          break;
        }

        case 'provider_info':
          state.setProvider(message.provider, message.agentId);
          break;

        case 'provider_change':
          state.setProvider(message.provider, message.agentId);
          state.addSystemMessage(
            message.reason ?? `Switched to ${message.provider}`,
            message.agentId
          );
          break;

        case 'compaction_start': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.startCompaction(aid);
          break;
        }

        case 'compaction_end': {
          const aid = message.agentId ?? state.guideAgentId;
          if (aid !== null) state.finishCompaction(aid);
          break;
        }

        case 'board_changed':
          usePushStore.getState().bumpBoard();
          break;

        case 'agents_changed':
          usePushStore.getState().bumpAgents();
          break;

        case 'artifacts_changed':
          usePushStore.getState().bumpArtifacts();
          break;

        case 'job_executions_changed':
          usePushStore.getState().bumpJobs();
          break;

        case 'agent_busy_changed':
          // Update busy state inline (no refetch needed)
          usePushStore
            .getState()
            .setAgentBusy(message.agentId, message.busy, message.contextPercent);
          break;

        case 'error': {
          console.error('Server error:', message.message);
          const aid = message.agentId ?? state.activeAgentId;
          if (aid !== null) state.setWaitingForResponse(false, aid);
          // If the failed agent is the active non-Guide agent, fall back to Guide
          // (handles stale persisted agent IDs from localStorage)
          if (
            message.agentId &&
            state.guideAgentId &&
            message.agentId === state.activeAgentId &&
            message.agentId !== state.guideAgentId
          ) {
            state.setActiveAgent(state.guideAgentId, 'guide');
          }
          break;
        }

        default:
          console.log('Unknown message type:', message);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      const state = useChatStore.getState();
      state.setConnected(false);
      state.clearAllStreamingState();
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      const state = useChatStore.getState();
      state.setConnected(false);
      state.clearAllStreamingState();
    };

    return () => {
      ws.close();
    };
  }, []);

  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const agentId = useChatStore.getState().activeAgentId;
      const msg: ClientMessage = {
        type: 'user_message',
        content,
        agentId: agentId ?? undefined,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendSteeringMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const agentId = useChatStore.getState().activeAgentId;
      const msg: ClientMessage = {
        type: 'steering_message',
        content,
        agentId: agentId ?? undefined,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const abort = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const agentId = useChatStore.getState().activeAgentId;
      const msg: ClientMessage = {
        type: 'abort',
        agentId: agentId ?? undefined,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendMessage, sendSteeringMessage, abort };
}
