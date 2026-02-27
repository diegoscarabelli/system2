/**
 * Message Input Component
 *
 * Text input for sending messages to the agent.
 */

import { useState } from 'react';
import { Box, Textarea, Button } from '@primer/react';
import { useChatStore } from '../stores/chat';

interface MessageInputProps {
  onSend: (message: string) => void;
}

export function MessageInput({ onSend }: MessageInputProps) {
  const [input, setInput] = useState('');
  const { isStreaming, isConnected } = useChatStore();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isStreaming) {
      onSend(input.trim());
      setInput('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      sx={{
        padding: 3,
        borderTop: '1px solid',
        borderColor: 'border.default',
      }}
    >
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          isConnected
            ? 'Ask the Guide a question...'
            : 'Connecting to server...'
        }
        disabled={!isConnected || isStreaming}
        sx={{ width: '100%', mb: 2 }}
        rows={3}
      />
      <Button
        type="submit"
        disabled={!isConnected || isStreaming || !input.trim()}
        variant="primary"
      >
        {isStreaming ? 'Agent is thinking...' : 'Send'}
      </Button>
    </Box>
  );
}
