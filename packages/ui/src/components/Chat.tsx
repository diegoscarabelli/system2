/**
 * Chat Component
 *
 * Main chat interface combining message list and input.
 */

import { Box } from '@primer/react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useChatStore } from '../stores/chat';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';

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
          Guide
        </Box>
      </Box>

      <MessageList />
      <MessageInput onSend={handleSend} />
    </Box>
  );
}
