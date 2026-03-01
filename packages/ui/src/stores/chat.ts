/**
 * Chat Store
 *
 * Zustand store for managing chat messages and connection state.
 * Tracks turn events (thinking, tool calls) in chronological order.
 */

import { create } from 'zustand';

export interface ToolCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  input?: string;
  result?: string;
  timestamp: number;
}

export interface ThinkingBlock {
  id: string;
  content: string;
  isStreaming: boolean;
  timestamp: number;
}

// Turn events preserve chronological order of thinking and tool calls
export type TurnEvent =
  | { type: 'thinking'; data: ThinkingBlock }
  | { type: 'tool_call'; data: ToolCall };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  // Assistant message metadata (persisted with message)
  turnEvents?: TurnEvent[];
}

interface ChatState {
  messages: Message[];
  // Current turn state (while streaming)
  currentAssistantMessage: string | null;
  currentTurnEvents: TurnEvent[];
  activeThinkingId: string | null; // ID of currently streaming thinking block
  isConnected: boolean;
  isStreaming: boolean;

  addUserMessage: (content: string) => void;
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
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  currentAssistantMessage: null,
  currentTurnEvents: [],
  activeThinkingId: null,
  isConnected: false,
  isStreaming: false,

  addUserMessage: (content: string) => {
    const message: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    set((state) => ({
      messages: [...state.messages, message],
      // Clear any lingering turn state when user sends new message
      currentTurnEvents: [],
      activeThinkingId: null,
    }));
  },

  startAssistantMessage: () => {
    set({ currentAssistantMessage: '', isStreaming: true });
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
      set({
        messages: [...state.messages, message],
        currentAssistantMessage: null,
        currentTurnEvents: [],
        activeThinkingId: null,
        isStreaming: false,
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
}));
