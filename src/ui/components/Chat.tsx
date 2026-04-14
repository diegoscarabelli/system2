/**
 * Chat Component
 *
 * Main chat interface combining message list and input.
 * Messages sent while the agent is working are delivered as steering
 * messages, which interrupt the current turn immediately.
 */

import { Box } from '@primer/react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useChatStore } from '../stores/chat';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';

export function Chat() {
  const { sendMessage, sendSteeringMessage, abort } = useWebSocket();
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const activeAgentLabel = useChatStore((s) => s.activeAgentLabel);

  const handleSend = (content: string) => {
    addUserMessage(content);
    sendMessage(content);
  };

  const handleSteer = (content: string) => {
    addUserMessage(content);
    sendSteeringMessage(content);
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
      <MessageInput onSend={handleSend} onSteer={handleSteer} onAbort={abort} />
    </Box>
  );
}
