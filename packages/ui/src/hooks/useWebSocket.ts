/**
 * WebSocket Hook
 *
 * Manages WebSocket connection to the server.
 * Supports message queueing with steering message priority.
 */

import type { ClientMessage, ServerMessage } from '@system2/shared';
import { useCallback, useEffect, useRef } from 'react';
import { useArtifactStore } from '../stores/artifact';
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
    setWaitingForResponse,
    addUserMessage,
    dequeueMessage,
  } = useChatStore();

  // Process the next queued message
  const processNextQueuedMessage = useCallback(() => {
    const nextMsg = dequeueMessage();
    if (nextMsg && wsRef.current?.readyState === WebSocket.OPEN) {
      // Add the queued message to the UI
      addUserMessage(nextMsg.content);

      const message: ClientMessage = {
        type: nextMsg.isSteering ? 'steering_message' : 'user_message',
        content: nextMsg.content,
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, [dequeueMessage, addUserMessage]);

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

        case 'ready_for_input':
          // Agent turn is fully complete - reset streaming state and process queue
          useChatStore.getState().setStreaming(false);
          setWaitingForResponse(false);
          processNextQueuedMessage();
          break;

        case 'chat_history':
          useChatStore.getState().loadHistory(message.messages);
          break;

        case 'user_message_broadcast':
          // User message sent from another tab — use server's ID and timestamp
          addUserMessage(message.content, message.id, message.timestamp);
          break;

        case 'context_usage':
          useChatStore.getState().setContextPercent(message.percent);
          break;

        case 'artifact': {
          const store = useArtifactStore.getState();
          if (message.filePath) {
            const existingTab = store.tabs.find((t) => t.filePath === message.filePath);
            if (existingTab) {
              store.reloadTab(message.filePath, message.url);
            } else {
              store.openArtifact(message.url, message.title, message.filePath);
            }
          } else {
            store.openArtifact(message.url, message.title);
          }
          break;
        }

        case 'provider_info':
          useChatStore.getState().setProvider(message.provider);
          break;

        case 'provider_change':
          useChatStore.getState().setProvider(message.provider);
          useChatStore.getState().addSystemMessage(`Switched to ${message.provider}`);
          break;

        case 'catalog_changed':
          useArtifactStore.getState().incrementCatalogVersion();
          break;

        case 'agents_changed':
          useArtifactStore.getState().incrementAgentsVersion();
          break;

        case 'error':
          console.error('Server error:', message.message);
          setWaitingForResponse(false);
          break;

        default:
          console.log('Unknown message type:', message);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnected(false);
      setWaitingForResponse(false);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
      setWaitingForResponse(false);
    };

    return () => {
      ws.close();
    };
  }, [
    addUserMessage,
    appendAssistantChunk,
    appendThinkingChunk,
    finishAssistantMessage,
    finishThinking,
    finishToolCall,
    processNextQueuedMessage,
    setConnected,
    setWaitingForResponse,
    startAssistantMessage,
    startThinking,
    startToolCall,
  ]);

  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: ClientMessage = {
        type: 'user_message',
        content,
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendSteeringMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: ClientMessage = {
        type: 'steering_message',
        content,
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const abort = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: ClientMessage = {
        type: 'abort',
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  return { sendMessage, sendSteeringMessage, abort };
}
