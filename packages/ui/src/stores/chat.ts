/**
 * Chat Store
 *
 * Zustand store for managing chat messages and connection state.
 * Supports per-agent state: each agent has its own message history
 * and streaming state. The active agent determines
 * which state is displayed in the UI.
 *
 * The server is the source of truth for message history.
 * On WebSocket connect, the server sends chat_history with recent messages.
 * Active agent selection is persisted to localStorage so it survives refreshes.
 */

import type { ChatMessage, ChatThinkingBlock, ChatToolCall, ChatTurnEvent } from '@system2/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Re-export shared types under the names UI components expect
export type Message = ChatMessage;
export type ToolCall = ChatToolCall;
export type ThinkingBlock = ChatThinkingBlock;
export type TurnEvent = ChatTurnEvent;

/** Per-agent streaming and message state. */
export interface PerAgentState {
  messages: Message[];
  currentAssistantMessage: string | null;
  currentTurnEvents: TurnEvent[];
  activeThinkingId: string | null;
  isStreaming: boolean;
  isWaitingForResponse: boolean;
  contextPercent: number | null;
  provider: string | null;
}

function createDefaultAgentState(): PerAgentState {
  return {
    messages: [],
    currentAssistantMessage: null,
    currentTurnEvents: [],
    activeThinkingId: null,
    isStreaming: false,
    isWaitingForResponse: false,
    contextPercent: null,
    provider: null,
  };
}

/** Stable default returned by selectors when no agent state exists yet. */
export const EMPTY_AGENT_STATE = createDefaultAgentState();

interface ChatState {
  // Per-agent state keyed by agentId
  agentStates: Map<number, PerAgentState>;
  // Active agent being viewed
  activeAgentId: number | null;
  activeAgentLabel: string | null; // e.g., "guide_1"
  activeAgentRole: string | null; // e.g., "Guide"
  // Guide agent ID (set on first connect)
  guideAgentId: number | null;
  // Global connection state
  isConnected: boolean;

  // Agent management
  setActiveAgent: (agentId: number, role: string) => void;
  setGuideAgentId: (id: number) => void;
  getAgentState: (agentId: number) => PerAgentState;
  getActiveState: () => PerAgentState;

  // Actions (agentId optional, defaults to active agent)
  addUserMessage: (content: string, id?: string, timestamp?: number, agentId?: number) => void;
  addSystemMessage: (content: string) => void;
  loadHistory: (messages: Message[], agentId: number) => void;
  startAssistantMessage: (agentId?: number) => void;
  appendAssistantChunk: (chunk: string, agentId?: number) => void;
  finishAssistantMessage: (agentId?: number) => void;
  startThinking: (agentId?: number) => void;
  appendThinkingChunk: (chunk: string, agentId?: number) => void;
  finishThinking: (agentId?: number) => void;
  startToolCall: (name: string, input?: string, agentId?: number) => void;
  finishToolCall: (name: string, result: string, agentId?: number) => void;
  setConnected: (connected: boolean) => void;
  clearAllStreamingState: () => void;
  setStreaming: (streaming: boolean, agentId?: number) => void;
  setWaitingForResponse: (waiting: boolean, agentId?: number) => void;
  setContextPercent: (percent: number | null, agentId?: number) => void;
  setProvider: (provider: string, agentId: number) => void;
}

/** Immutably update a specific agent's state within the Map. */
function updateAgentState(
  states: Map<number, PerAgentState>,
  agentId: number,
  updater: (state: PerAgentState) => Partial<PerAgentState>
): Map<number, PerAgentState> {
  const current = states.get(agentId) ?? createDefaultAgentState();
  const updated = { ...current, ...updater(current) };
  const next = new Map(states);
  next.set(agentId, updated);
  return next;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      agentStates: new Map(),
      activeAgentId: null,
      activeAgentLabel: null,
      activeAgentRole: null,
      guideAgentId: null,
      isConnected: false,

      setActiveAgent: (agentId: number, role: string) => {
        const label = `${role}_${agentId}`;
        const displayRole = role.charAt(0).toUpperCase() + role.slice(1);
        set({
          activeAgentId: agentId,
          activeAgentLabel: label,
          activeAgentRole: displayRole,
        });
      },

      setGuideAgentId: (id: number) => {
        set({ guideAgentId: id });
      },

      getAgentState: (agentId: number) => {
        return get().agentStates.get(agentId) ?? EMPTY_AGENT_STATE;
      },

      getActiveState: () => {
        const { activeAgentId, agentStates } = get();
        if (activeAgentId === null) return EMPTY_AGENT_STATE;
        return agentStates.get(activeAgentId) ?? EMPTY_AGENT_STATE;
      },

      addUserMessage: (content: string, id?: string, timestamp?: number, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        const message: Message = {
          id: id ?? `msg-${Date.now()}`,
          role: 'user',
          content,
          timestamp: timestamp ?? Date.now(),
        };
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            messages: [...s.messages, message],
            currentTurnEvents: [],
            activeThinkingId: null,
            isWaitingForResponse: true,
          })),
        }));
      },

      addSystemMessage: (content: string) => {
        const targetId = get().activeAgentId;
        if (targetId === null) return;

        const message: Message = {
          id: `msg-${Date.now()}`,
          role: 'system',
          content,
          timestamp: Date.now(),
        };
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            messages: [...s.messages, message],
          })),
        }));
      },

      loadHistory: (messages: Message[], agentId: number) => {
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, agentId, () => ({
            messages,
            currentAssistantMessage: null,
            currentTurnEvents: [],
            activeThinkingId: null,
            isStreaming: false,
            isWaitingForResponse: false,
          })),
        }));
      },

      startAssistantMessage: (agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, () => ({
            currentAssistantMessage: '',
            isStreaming: true,
            isWaitingForResponse: false,
          })),
        }));
      },

      appendAssistantChunk: (chunk: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentAssistantMessage: (s.currentAssistantMessage || '') + chunk,
          })),
        }));
      },

      finishAssistantMessage: (agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        const agentState = get().agentStates.get(targetId);
        if (!agentState) return;

        const content = agentState.currentAssistantMessage;
        if (content) {
          const message: Message = {
            id: `msg-${Date.now()}`,
            role: 'assistant',
            content,
            timestamp: Date.now(),
            turnEvents:
              agentState.currentTurnEvents.length > 0
                ? [...agentState.currentTurnEvents]
                : undefined,
          };
          set((state) => ({
            agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
              messages: [...s.messages, message],
              currentAssistantMessage: null,
              currentTurnEvents: [],
              activeThinkingId: null,
            })),
          }));
        }
      },

      startThinking: (agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        const thinkingId = `thinking-${Date.now()}`;
        const thinkingBlock: ThinkingBlock = {
          id: thinkingId,
          content: '',
          isStreaming: true,
          timestamp: Date.now(),
        };
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentTurnEvents: [...s.currentTurnEvents, { type: 'thinking', data: thinkingBlock }],
            activeThinkingId: thinkingId,
            isStreaming: true,
            isWaitingForResponse: false,
          })),
        }));
      },

      appendThinkingChunk: (chunk: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        const agentState = get().agentStates.get(targetId);
        if (!agentState?.activeThinkingId) return;

        const activeId = agentState.activeThinkingId;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentTurnEvents: s.currentTurnEvents.map((event) =>
              event.type === 'thinking' && event.data.id === activeId
                ? { ...event, data: { ...event.data, content: event.data.content + chunk } }
                : event
            ),
          })),
        }));
      },

      finishThinking: (agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        const agentState = get().agentStates.get(targetId);
        if (!agentState?.activeThinkingId) return;

        const activeId = agentState.activeThinkingId;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentTurnEvents: s.currentTurnEvents.map((event) =>
              event.type === 'thinking' && event.data.id === activeId
                ? { ...event, data: { ...event.data, isStreaming: false } }
                : event
            ),
            activeThinkingId: null,
          })),
        }));
      },

      startToolCall: (name: string, input?: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        // If there's active thinking, finish it first
        const agentState = get().agentStates.get(targetId);
        if (agentState?.activeThinkingId) {
          get().finishThinking(targetId);
        }

        const toolCall: ToolCall = {
          id: `tool-${Date.now()}`,
          name,
          input,
          status: 'running',
          timestamp: Date.now(),
        };
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentTurnEvents: [...s.currentTurnEvents, { type: 'tool_call', data: toolCall }],
            isStreaming: true,
            isWaitingForResponse: false,
          })),
        }));
      },

      finishToolCall: (name: string, result: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentTurnEvents: s.currentTurnEvents.map((event) =>
              event.type === 'tool_call' &&
              event.data.name === name &&
              event.data.status === 'running'
                ? { ...event, data: { ...event.data, status: 'completed' as const, result } }
                : event
            ),
          })),
        }));
      },

      setConnected: (connected: boolean) => {
        set({ isConnected: connected });
      },

      clearAllStreamingState: () => {
        set((state) => {
          const next = new Map(state.agentStates);
          for (const [id, s] of next) {
            if (
              s.isStreaming ||
              s.isWaitingForResponse ||
              s.activeThinkingId ||
              s.currentAssistantMessage
            ) {
              next.set(id, {
                ...s,
                isStreaming: false,
                isWaitingForResponse: false,
                activeThinkingId: null,
                currentAssistantMessage: null,
                currentTurnEvents: [],
              });
            }
          }
          return { agentStates: next };
        });
      },

      setStreaming: (streaming: boolean, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, () => ({
            isStreaming: streaming,
          })),
        }));
      },

      setWaitingForResponse: (waiting: boolean, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, () => ({
            isWaitingForResponse: waiting,
          })),
        }));
      },

      setContextPercent: (percent: number | null, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, () => ({
            contextPercent: percent,
          })),
        }));
      },

      setProvider: (provider: string, agentId: number) => {
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, agentId, () => ({ provider })),
        }));
      },
    }),
    {
      name: 'system2:chat-store',
      partialize: (state) => ({
        activeAgentId: state.activeAgentId,
        activeAgentLabel: state.activeAgentLabel,
        activeAgentRole: state.activeAgentRole,
      }),
    }
  )
);
