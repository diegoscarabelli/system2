/**
 * WebSocket Hook
 *
 * Manages WebSocket connection to the gateway server.
 */

import { useEffect, useRef } from 'react';
import type { ClientMessage, ServerMessage } from '@system2/shared';
import { useChatStore } from '../stores/chat';

const WS_URL = `ws://${window.location.hostname}:3000`;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const {
    startAssistantMessage,
    appendAssistantChunk,
    finishAssistantMessage,
    startThinking,
    appendThinkingChunk,
    finishThinking,
    startToolCall,
    finishToolCall,
    setConnected,
  } = useChatStore();

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;

      switch (message.type) {
        case 'thinking_chunk':
          // Start new thinking block if none is active
          if (!useChatStore.getState().activeThinkingId && message.content) {
            startThinking();
          }
          appendThinkingChunk(message.content);
          break;

        case 'thinking_end':
          finishThinking();
          break;

        case 'assistant_chunk':
          // First chunk starts the message
          if (!useChatStore.getState().currentAssistantMessage && message.content) {
            finishThinking(); // Finish any active thinking
            startAssistantMessage();
          }
          appendAssistantChunk(message.content);
          break;

        case 'assistant_end':
          finishAssistantMessage();
          break;

        case 'tool_call_start':
          startToolCall(message.name, message.input);
          break;

        case 'tool_call_end':
          finishToolCall(message.name, message.result);
          break;

        case 'error':
          console.error('Server error:', message.message);
          break;

        default:
          console.log('Unknown message type:', message);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnected(false);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  const sendMessage = (content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: ClientMessage = {
        type: 'user_message',
        content,
      };
      wsRef.current.send(JSON.stringify(message));
    }
  };

  const abort = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: ClientMessage = {
        type: 'abort',
      };
      wsRef.current.send(JSON.stringify(message));
    }
  };

  return { sendMessage, abort };
}
