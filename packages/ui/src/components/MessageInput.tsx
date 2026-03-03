/**
 * Message Input Component
 *
 * Text input for sending messages to the agent.
 * Auto-growing textarea that expands up to 10 lines, then scrolls.
 * Supports queueing messages while the agent is working.
 */

import { Box, Button } from '@primer/react';
import { useRef, useState } from 'react';
import { useChatStore } from '../stores/chat';

const LINE_HEIGHT = 20; // px per line
const MIN_LINES = 1;
const MAX_LINES = 10;
const PADDING_Y = 16; // vertical padding inside textarea

interface MessageInputProps {
  onSend: (message: string) => void;
  onQueue: (message: string, isSteering?: boolean) => void;
}

export function MessageInput({ onSend, onQueue }: MessageInputProps) {
  const [input, setInput] = useState('');
  const { isStreaming, isConnected, messageQueue } = useChatStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    if (isStreaming) {
      onQueue(input.trim());
    } else {
      onSend(input.trim());
    }
    setInput('');
    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_LINES * LINE_HEIGHT + PADDING_Y}px`;
      textareaRef.current.style.overflowY = 'hidden';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const autoResize = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset to min height to get accurate scrollHeight
    textarea.style.height = `${MIN_LINES * LINE_HEIGHT + PADDING_Y}px`;

    const maxHeight = MAX_LINES * LINE_HEIGHT + PADDING_Y;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      sx={{
        borderTop: '1px solid',
        borderColor: 'border.default',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ padding: 3 }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            requestAnimationFrame(autoResize);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            !isConnected
              ? 'Connecting to server...'
              : isStreaming
                ? 'Type to queue a message...'
                : 'Ask the Guide a question...'
          }
          disabled={!isConnected}
          rows={1}
          style={{
            width: '100%',
            marginBottom: '8px',
            resize: 'none',
            lineHeight: `${LINE_HEIGHT}px`,
            padding: '8px 12px',
            fontFamily: 'inherit',
            fontSize: '14px',
            border: '1px solid var(--borderColor-default, #373e47)',
            borderRadius: '6px',
            backgroundColor: 'var(--bgColor-default, #0d1117)',
            color: 'var(--fgColor-default, #e6edf3)',
            outline: 'none',
            boxSizing: 'border-box',
            overflowY: 'hidden',
          }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Button type="submit" disabled={!isConnected || !input.trim()} variant="primary">
            {isStreaming ? 'Queue' : 'Send'}
          </Button>
          {messageQueue.length > 0 && (
            <Box sx={{ fontSize: 0, color: 'fg.muted' }}>
              {messageQueue.length} message{messageQueue.length > 1 ? 's' : ''} queued
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
