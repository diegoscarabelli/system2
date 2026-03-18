/**
 * Chat Component
 *
 * Main chat interface combining message list and input.
 * Supports message queueing while the agent is working.
 */

import { Box } from '@primer/react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useChatStore } from '../stores/chat';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';

export function Chat() {
  const { sendMessage, abort } = useWebSocket();
  const { addUserMessage, queueMessage, activeAgentLabel } = useChatStore();

  const handleSend = (content: string) => {
    addUserMessage(content);
    sendMessage(content);
  };

  const handleQueue = (content: string, isSteering = false) => {
    queueMessage(content, isSteering);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'canvas.default',
      }}
    >
      <Box
        sx={{
          padding: 2,
          borderBottom: '1px solid',
          borderColor: 'border.default',
        }}
      >
        <Box as="h2" sx={{ fontSize: 2, fontWeight: 'bold', margin: 0 }}>
          {activeAgentLabel ?? 'System2'}
        </Box>
      </Box>

      <MessageList />
      <MessageInput onSend={handleSend} onQueue={handleQueue} onAbort={abort} />
    </Box>
  );
}
