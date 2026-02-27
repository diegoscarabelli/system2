/**
 * Chat Component
 *
 * Main chat interface combining message list and input.
 */

import { Box } from '@primer/react';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { useChatStore } from '../stores/chat';
import { useWebSocket } from '../hooks/useWebSocket';

export function Chat() {
  const { sendMessage } = useWebSocket();
  const { addUserMessage } = useChatStore();

  const handleSend = (content: string) => {
    addUserMessage(content);
    sendMessage(content);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: 'canvas.default',
      }}
    >
      <Box
        sx={{
          padding: 3,
          borderBottom: '1px solid',
          borderColor: 'border.default',
          backgroundColor: 'canvas.subtle',
        }}
      >
        <Box as="h1" sx={{ fontSize: 3, fontWeight: 'bold', margin: 0 }}>
          System2
        </Box>
        <Box as="p" sx={{ fontSize: 1, color: 'fg.muted', margin: 0 }}>
          Your AI data team
        </Box>
      </Box>

      <MessageList />
      <MessageInput onSend={handleSend} />
    </Box>
  );
}
