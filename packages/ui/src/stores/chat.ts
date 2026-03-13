/**
 * Chat Store
 *
 * Zustand store for managing chat messages and connection state.
 * Tracks turn events (thinking, tool calls) in chronological order.
 *
 * The server is the source of truth for message history.
 * On WebSocket connect, the server sends chat_history with recent messages.
 * No localStorage persistence — the UI state is ephemeral.
 */

import type { ChatMessage, ChatThinkingBlock, ChatToolCall, ChatTurnEvent } from '@system2/shared';
import { create } from 'zustand';

// Re-export shared types under the names UI components expect
export type Message = ChatMessage;
export type ToolCall = ChatToolCall;
export type ThinkingBlock = ChatThinkingBlock;
export type TurnEvent = ChatTurnEvent;

// Queued message for sending when agent is ready
export interface QueuedMessage {
  id: string;
  content: string;
  isSteering: boolean; // Steering messages are inserted ASAP into the agent loop
  timestamp: number;
}

interface ChatState {
  messages: Message[];
  // Current turn state (while streaming)
  currentAssistantMessage: string | null;
  currentTurnEvents: TurnEvent[];
  activeThinkingId: string | null; // ID of currently streaming thinking block
  isConnected: boolean;
  isStreaming: boolean;
  isWaitingForResponse: boolean; // True after user sends, before first chunk arrives
  // Message queue
  messageQueue: QueuedMessage[];
  // Context window usage
  contextPercent: number | null;
  // Current LLM provider
  provider: string | null;

  addUserMessage: (content: string, id?: string, timestamp?: number) => void;
  addSystemMessage: (content: string) => void;
  loadHistory: (messages: Message[]) => void;
  queueMessage: (content: string, isSteering?: boolean) => void;
  dequeueMessage: () => QueuedMessage | undefined;
  clearQueue: () => void;
  startAssistantMessage: () => void;
  appendAssistantChunk: (chunk: string) => void;
  finishAssistantMessage: () => void;
  startThinking: () => void;
  appendThinkingChunk: (chunk: string) => void;
  finishThinking: () => void;
  startToolCall: (name: string, input?: string) => void;
  finishToolCall: (name: string, result: string) => void;
  setConnected: (connected: boolean) => void;
  setStreaming: (streaming: boolean) => void;
  setWaitingForResponse: (waiting: boolean) => void;
  setContextPercent: (percent: number | null) => void;
  setProvider: (provider: string) => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  currentAssistantMessage: null,
  currentTurnEvents: [],
  activeThinkingId: null,
  isConnected: false,
  isStreaming: false,
  isWaitingForResponse: false,
  messageQueue: [],
  contextPercent: null,
  provider: null,

  addUserMessage: (content: string, id?: string, timestamp?: number) => {
    const message: Message = {
      id: id ?? `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: timestamp ?? Date.now(),
    };
    set((state) => ({
      messages: [...state.messages, message],
      // Clear any lingering turn state when user sends new message
      currentTurnEvents: [],
      activeThinkingId: null,
      isWaitingForResponse: true,
    }));
  },

  addSystemMessage: (content: string) => {
    const message: Message = {
      id: `msg-${Date.now()}`,
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    set((state) => ({
      messages: [...state.messages, message],
    }));
  },

  loadHistory: (messages: Message[]) => {
    set({ messages });
  },

  queueMessage: (content: string, isSteering = false) => {
    const queuedMsg: QueuedMessage = {
      id: `queued-${Date.now()}`,
      content,
      isSteering,
      timestamp: Date.now(),
    };
    set((state) => {
      // Steering messages go to the front of the queue
      if (isSteering) {
        return { messageQueue: [queuedMsg, ...state.messageQueue] };
      }
      return { messageQueue: [...state.messageQueue, queuedMsg] };
    });
  },

  dequeueMessage: () => {
    const state = get();
    if (state.messageQueue.length === 0) return undefined;
    const [next, ...rest] = state.messageQueue;
    set({ messageQueue: rest });
    return next;
  },

  clearQueue: () => {
    set({ messageQueue: [] });
  },

  startAssistantMessage: () => {
    set({ currentAssistantMessage: '', isStreaming: true, isWaitingForResponse: false });
  },

  appendAssistantChunk: (chunk: string) => {
    set((state) => ({
      currentAssistantMessage: (state.currentAssistantMessage || '') + chunk,
    }));
  },

  finishAssistantMessage: () => {
    const state = get();
    const content = state.currentAssistantMessage;
    if (content) {
      const message: Message = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        // Persist turn events in chronological order
        turnEvents: state.currentTurnEvents.length > 0 ? [...state.currentTurnEvents] : undefined,
      };
      // Note: isStreaming stays true — the agent may still have tool calls
      // and more responses. It's set to false only on ready_for_input.
      set({
        messages: [...state.messages, message],
        currentAssistantMessage: null,
        currentTurnEvents: [],
        activeThinkingId: null,
      });
    }
  },

  startThinking: () => {
    const thinkingId = `thinking-${Date.now()}`;
    const thinkingBlock: ThinkingBlock = {
      id: thinkingId,
      content: '',
      isStreaming: true,
      timestamp: Date.now(),
    };
    set((state) => ({
      currentTurnEvents: [...state.currentTurnEvents, { type: 'thinking', data: thinkingBlock }],
      activeThinkingId: thinkingId,
      isStreaming: true,
      isWaitingForResponse: false,
    }));
  },

  appendThinkingChunk: (chunk: string) => {
    const state = get();
    if (!state.activeThinkingId) return;

    set((state) => ({
      currentTurnEvents: state.currentTurnEvents.map((event) =>
        event.type === 'thinking' && event.data.id === state.activeThinkingId
          ? { ...event, data: { ...event.data, content: event.data.content + chunk } }
          : event
      ),
    }));
  },

  finishThinking: () => {
    const state = get();
    if (!state.activeThinkingId) return;

    set((state) => ({
      currentTurnEvents: state.currentTurnEvents.map((event) =>
        event.type === 'thinking' && event.data.id === state.activeThinkingId
          ? { ...event, data: { ...event.data, isStreaming: false } }
          : event
      ),
      activeThinkingId: null,
    }));
  },

  startToolCall: (name: string, input?: string) => {
    // If there's active thinking, finish it first (tool call interrupts thinking)
    const state = get();
    if (state.activeThinkingId) {
      get().finishThinking();
    }

    const toolCall: ToolCall = {
      id: `tool-${Date.now()}`,
      name,
      input,
      status: 'running',
      timestamp: Date.now(),
    };
    set((state) => ({
      currentTurnEvents: [...state.currentTurnEvents, { type: 'tool_call', data: toolCall }],
      isStreaming: true,
      isWaitingForResponse: false,
    }));
  },

  finishToolCall: (name: string, result: string) => {
    set((state) => ({
      currentTurnEvents: state.currentTurnEvents.map((event) =>
        event.type === 'tool_call' && event.data.name === name && event.data.status === 'running'
          ? { ...event, data: { ...event.data, status: 'completed' as const, result } }
          : event
      ),
    }));
  },

  setConnected: (connected: boolean) => {
    set({ isConnected: connected });
  },

  setStreaming: (streaming: boolean) => {
    set({ isStreaming: streaming });
  },

  setWaitingForResponse: (waiting: boolean) => {
    set({ isWaitingForResponse: waiting });
  },

  setContextPercent: (percent: number | null) => {
    set({ contextPercent: percent });
  },

  setProvider: (provider: string) => {
    set({ provider });
  },
}));
