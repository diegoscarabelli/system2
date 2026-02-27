/**
 * Chat Store
 *
 * Zustand store for managing chat messages and connection state.
 */

import { create } from 'zustand';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  result?: string;
  timestamp: number;
}

interface ChatState {
  messages: Message[];
  currentAssistantMessage: string | null;
  toolCalls: ToolCall[];
  isConnected: boolean;
  isStreaming: boolean;

  addUserMessage: (content: string) => void;
  startAssistantMessage: () => void;
  appendAssistantChunk: (chunk: string) => void;
  finishAssistantMessage: () => void;
  startToolCall: (name: string) => void;
  finishToolCall: (name: string, result: string) => void;
  setConnected: (connected: boolean) => void;
  setStreaming: (streaming: boolean) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  currentAssistantMessage: null,
  toolCalls: [],
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
    const content = get().currentAssistantMessage;
    if (content) {
      const message: Message = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      };
      set((state) => ({
        messages: [...state.messages, message],
        currentAssistantMessage: null,
        isStreaming: false,
      }));
    }
  },

  startToolCall: (name: string) => {
    const toolCall: ToolCall = {
      id: `tool-${Date.now()}`,
      name,
      status: 'running',
      timestamp: Date.now(),
    };
    set((state) => ({
      toolCalls: [...state.toolCalls, toolCall],
    }));
  },

  finishToolCall: (name: string, result: string) => {
    set((state) => ({
      toolCalls: state.toolCalls.map((tc) =>
        tc.name === name && tc.status === 'running'
          ? { ...tc, status: 'completed' as const, result }
          : tc
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
