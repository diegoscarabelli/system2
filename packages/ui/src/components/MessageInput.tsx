/**
 * Message Input Component
 *
 * Text input for sending messages to the agent.
 * Features a resizable textarea with a horizontal drag handle.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Textarea, Button } from '@primer/react';
import { useChatStore } from '../stores/chat';

interface MessageInputProps {
  onSend: (message: string) => void;
}

export function MessageInput({ onSend }: MessageInputProps) {
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(80); // pixels
  const { isStreaming, isConnected } = useChatStore();
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newHeight = containerRect.bottom - e.clientY - 50; // 50px for button area

    // Clamp between 40px and 300px
    setInputHeight(Math.max(40, Math.min(300, newHeight)));
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <Box
      ref={containerRef}
      as="form"
      onSubmit={handleSubmit}
      sx={{
        borderTop: '1px solid',
        borderColor: 'border.default',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Resize handle */}
      <Box
        onMouseDown={handleMouseDown}
        sx={{
          height: '4px',
          cursor: 'row-resize',
          backgroundColor: 'border.default',
          '&:hover': {
            backgroundColor: 'accent.emphasis',
          },
          flexShrink: 0,
        }}
      />

      <Box sx={{ padding: 3 }}>
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
          sx={{
            width: '100%',
            mb: 2,
            resize: 'none',
            height: `${inputHeight}px`,
          }}
        />
        <Button
          type="submit"
          disabled={!isConnected || isStreaming || !input.trim()}
          variant="primary"
        >
          {isStreaming ? 'Agent is thinking...' : 'Send'}
        </Button>
      </Box>
    </Box>
  );
}
