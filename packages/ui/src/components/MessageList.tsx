/**
 * Message List Component
 *
 * Displays the conversation history.
 */

import { useEffect, useRef } from 'react';
import { Box, Text } from '@primer/react';
import { useChatStore } from '../stores/chat';

export function MessageList() {
  const { messages, currentAssistantMessage, toolCalls } = useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentAssistantMessage]);

  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        padding: 3,
      }}
    >
      {messages.length === 0 && !currentAssistantMessage && (
        <Box
          sx={{
            textAlign: 'center',
            color: 'fg.muted',
            paddingTop: 6,
          }}
        >
          <Text sx={{ fontSize: 1 }}>
            Welcome to System2! The Guide is ready to help you configure your data infrastructure.
          </Text>
        </Box>
      )}

      {messages.map((message) => (
        <Box
          key={message.id}
          sx={{
            marginBottom: 3,
            padding: 3,
            backgroundColor:
              message.role === 'user' ? 'canvas.subtle' : 'canvas.default',
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'border.default',
          }}
        >
          <Text
            sx={{
              fontWeight: 'bold',
              fontSize: 1,
              color: message.role === 'user' ? 'accent.fg' : 'success.fg',
              marginBottom: 2,
            }}
          >
            {message.role === 'user' ? 'You' : 'Guide'}
          </Text>
          <Text
            as="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'mono',
              fontSize: 1,
            }}
          >
            {message.content}
          </Text>
        </Box>
      ))}

      {/* Current streaming message */}
      {currentAssistantMessage && (
        <Box
          sx={{
            marginBottom: 3,
            padding: 3,
            backgroundColor: 'canvas.default',
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'border.default',
          }}
        >
          <Text
            sx={{
              fontWeight: 'bold',
              fontSize: 1,
              color: 'success.fg',
              marginBottom: 2,
            }}
          >
            Guide
          </Text>
          <Text
            as="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'mono',
              fontSize: 1,
            }}
          >
            {currentAssistantMessage}
          </Text>
        </Box>
      )}

      {/* Tool calls */}
      {toolCalls.filter((tc) => tc.status === 'running').length > 0 && (
        <Box
          sx={{
            marginBottom: 3,
            padding: 3,
            backgroundColor: 'attention.subtle',
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'attention.emphasis',
          }}
        >
          <Text sx={{ fontSize: 1, fontStyle: 'italic' }}>
            Running tool:{' '}
            {toolCalls
              .filter((tc) => tc.status === 'running')
              .map((tc) => tc.name)
              .join(', ')}
          </Text>
        </Box>
      )}

      <div ref={messagesEndRef} />
    </Box>
  );
}
