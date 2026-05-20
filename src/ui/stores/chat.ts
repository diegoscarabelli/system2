/**
 * Chat Store
 *
 * Zustand store for managing chat messages and connection state.
 * Supports per-agent state: each agent has its own message history
 * and streaming state. The active agent determines which state is displayed.
 *
 * The server's chatCache is the single source of truth for committed messages.
 * Two paths populate `messages[]`:
 *   - `loadHistory(...)`: full snapshot on connect / agent switch.
 *   - `appendMessage(msg, agentId)`: incremental row from `chat_message_added`.
 * Both are dedup-by-id. Streaming events (assistant chunks, tool calls) build a
 * TRANSIENT draft (`currentAssistantMessage`, `currentTurnEvents`) above the
 * committed list; when the canonical assistant message arrives via
 * `appendMessage`, the draft is cleared atomically with the append.
 *
 * `addUserMessage` is an optimistic insert used by the originating tab for
 * instant feedback; the server reuses the client-provided id so the echoed
 * `chat_message_added` dedups cleanly.
 *
 * Active agent selection is persisted to localStorage so it survives refreshes.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ChatMessage,
  ChatThinkingBlock,
  ChatToolCall,
  ChatTurnEvent,
} from '../../shared/index.js';

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
  provider: string | null;
  compactionStatus: 'idle' | 'compacting';
  compactionTimestamp: number | null;
  inputDraft: string;
}

function createDefaultAgentState(): PerAgentState {
  return {
    messages: [],
    currentAssistantMessage: null,
    currentTurnEvents: [],
    activeThinkingId: null,
    isStreaming: false,
    isWaitingForResponse: false,
    provider: null,
    compactionStatus: 'idle',
    compactionTimestamp: null,
    inputDraft: '',
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
  addUserMessage: (content: string, agentId?: number) => string; // Returns the generated id (for server reuse)
  appendMessage: (message: Message, agentId?: number) => void; // Server-driven canonical insert
  loadHistory: (messages: Message[], agentId: number) => void;
  startAssistantMessage: (agentId?: number) => void;
  appendAssistantChunk: (chunk: string, agentId?: number) => void;
  clearAssistantDraft: (agentId?: number) => void; // Called on assistant_end; canonical row arrives via appendMessage
  startThinking: (agentId?: number) => void;
  appendThinkingChunk: (chunk: string, agentId?: number) => void;
  finishThinking: (agentId?: number) => void;
  startToolCall: (name: string, input?: string, agentId?: number) => void;
  updateToolCallProgress: (name: string, message: string, agentId?: number) => void;
  finishToolCall: (name: string, result: string, agentId?: number) => void;
  setConnected: (connected: boolean) => void;
  clearAllStreamingState: () => void;
  setStreaming: (streaming: boolean, agentId?: number) => void;
  setWaitingForResponse: (waiting: boolean, agentId?: number) => void;
  setProvider: (provider: string, agentId: number) => void;
  startCompaction: (agentId: number) => void;
  finishCompaction: (agentId: number) => void;
  resetCompaction: (agentId: number) => void;
  setInputDraft: (value: string, agentId?: number) => void;
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

      addUserMessage: (content: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        // crypto.randomUUID(): dedup-by-id makes id uniqueness load-bearing
        // (collisions silently drop rows). Available in every browser since
        // ~2021 and in Node test environments. The `msg-` prefix is purely
        // cosmetic for log-grepping.
        const id = `msg-${crypto.randomUUID()}`;
        if (targetId === null) return id;

        const agentState = get().agentStates.get(targetId);
        const isSteering = agentState?.isStreaming ?? false;

        const message: Message = {
          id,
          role: 'user',
          content,
          timestamp: Date.now(),
        };
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            messages: [...s.messages, message],
            // Steering: leave the draft alone; the server's history-capture
            // will push the partial assistant row via chat_message_added.
            // Non-steering: a brand-new turn — set waiting indicator.
            isWaitingForResponse: !isSteering,
          })),
        }));
        return id;
      },

      appendMessage: (message: Message, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;

        set((state) => {
          const current = state.agentStates.get(targetId) ?? createDefaultAgentState();
          // Dedup-by-id: covers (a) the originating tab's optimistic insert
          // echoed back by chat_message_added, and (b) any race between the
          // initial chat_history snapshot and live pushes that arrived during
          // the subscribe-then-snapshot window.
          if (current.messages.some((m) => m.id === message.id)) {
            return state;
          }
          const isCanonicalAssistant = message.role === 'assistant';
          return {
            agentStates: updateAgentState(state.agentStates, targetId, () => ({
              messages: [...current.messages, message],
              // The canonical assistant row arrives with text + turnEvents
              // baked in; the streaming draft becomes redundant.
              ...(isCanonicalAssistant
                ? {
                    currentAssistantMessage: null,
                    currentTurnEvents: [],
                    activeThinkingId: null,
                  }
                : {}),
            })),
          };
        });
      },

      loadHistory: (messages: Message[], agentId: number) => {
        set((state) => {
          const existing = state.agentStates.get(agentId);
          const hasInProgress =
            existing &&
            (existing.isStreaming ||
              existing.currentTurnEvents.length > 0 ||
              existing.currentAssistantMessage);

          // Merge the snapshot with any rows that already arrived via
          // appendMessage (chat_message_added). Snapshot is the canonical
          // base (preserves the persisted order); anything in current that
          // isn't in the snapshot — by id — is appended at the tail. This
          // makes the listener-then-snapshot window of the constructor /
          // switch_agent flow robust: a push that lands between subscribe
          // and snapshot won't be dropped by loadHistory overwriting messages.
          const snapshotIds = new Set(messages.map((m) => m.id));
          const tail = existing?.messages.filter((m) => !snapshotIds.has(m.id)) ?? [];
          const merged = tail.length > 0 ? [...messages, ...tail] : messages;

          // If agent has in-progress work (e.g., switching back to a busy agent),
          // only update committed messages and preserve streaming state.
          if (hasInProgress) {
            return {
              agentStates: updateAgentState(state.agentStates, agentId, () => ({
                messages: merged,
              })),
            };
          }

          return {
            agentStates: updateAgentState(state.agentStates, agentId, () => ({
              messages: merged,
              currentAssistantMessage: null,
              currentTurnEvents: [],
              activeThinkingId: null,
              isStreaming: false,
              isWaitingForResponse: false,
            })),
          };
        });
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

      clearAssistantDraft: (agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        // Safety net for turns that produced no committed message (e.g. an
        // immediately-aborted stream): if appendMessage already cleared the
        // draft via the canonical assistant row, this is a no-op.
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, () => ({
            currentAssistantMessage: null,
            currentTurnEvents: [],
            activeThinkingId: null,
          })),
        }));
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

      updateToolCallProgress: (name: string, message: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, (s) => ({
            currentTurnEvents: s.currentTurnEvents.map((event) =>
              event.type === 'tool_call' &&
              event.data.name === name &&
              event.data.status === 'running'
                ? {
                    ...event,
                    data: { ...event.data, progressMessage: message },
                  }
                : event
            ),
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
              s.currentAssistantMessage ||
              s.compactionStatus !== 'idle'
            ) {
              next.set(id, {
                ...s,
                isStreaming: false,
                isWaitingForResponse: false,
                activeThinkingId: null,
                currentAssistantMessage: null,
                currentTurnEvents: [],
                compactionStatus: 'idle',
                compactionTimestamp: null,
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

      setProvider: (provider: string, agentId: number) => {
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, agentId, () => ({ provider })),
        }));
      },

      startCompaction: (agentId: number) => {
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, agentId, () => ({
            compactionStatus: 'compacting' as const,
            compactionTimestamp: Date.now(),
            isStreaming: true,
          })),
        }));
      },

      finishCompaction: (agentId: number) => {
        // Transition straight back to idle on compaction_end. The persisted
        // "Context compacted" system message from history-capture records the
        // event in correct chronological position; the transient indicator
        // only needs to exist during the in-flight window.
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, agentId, () => ({
            compactionStatus: 'idle' as const,
            compactionTimestamp: null,
            isStreaming: false,
          })),
        }));
      },

      resetCompaction: (agentId: number) => {
        const agentState = get().agentStates.get(agentId);
        if (!agentState || agentState.compactionStatus === 'idle') return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, agentId, () => ({
            compactionStatus: 'idle' as const,
            compactionTimestamp: null,
          })),
        }));
      },

      setInputDraft: (value: string, agentId?: number) => {
        const targetId = agentId ?? get().activeAgentId;
        if (targetId === null) return;
        set((state) => ({
          agentStates: updateAgentState(state.agentStates, targetId, () => ({
            inputDraft: value,
          })),
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
