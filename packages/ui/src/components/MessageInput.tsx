/**
 * Message Input Component
 *
 * Text input for sending messages to the agent.
 * Auto-growing textarea that expands up to 10 lines, then scrolls.
 * Supports queueing messages while the agent is working.
 */

import { ArrowUpIcon, SquareFillIcon } from '@primer/octicons-react';
import { Box } from '@primer/react';
import { useRef, useState } from 'react';
import { EMPTY_AGENT_STATE, useChatStore } from '../stores/chat';
import { colors, contextColor } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';

const LINE_HEIGHT = 20; // px per line
const MIN_LINES = 1;
const MAX_LINES = 10;
const PADDING_Y = 16; // vertical padding inside textarea

interface MessageInputProps {
  onSend: (message: string) => void;
  onQueue: (message: string, isSteering?: boolean) => void;
  onAbort: () => void;
}

export function MessageInput({ onSend, onQueue, onAbort }: MessageInputProps) {
  const [input, setInput] = useState('');
  const isConnected = useChatStore((s) => s.isConnected);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const activeAgentRole = useChatStore((s) => s.activeAgentRole);
  const activeState = useChatStore((s) => {
    if (s.activeAgentId === null) return EMPTY_AGENT_STATE;
    return s.agentStates.get(s.activeAgentId) ?? EMPTY_AGENT_STATE;
  });
  const provider = useChatStore((s) => s.provider);
  const { isStreaming, isWaitingForResponse, messageQueue, contextPercent } = activeState;
  const { accent, accentHover } = useAccentColors();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !isConnected || activeAgentId === null) return;

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

  const ctxColor = contextPercent !== null ? contextColor(contextPercent, accent) : colors.teal;

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
                : `Message ${activeAgentRole ?? 'Agent'}...`
          }
          disabled={!isConnected || activeAgentId === null}
          rows={1}
          style={{
            width: '100%',
            marginBottom: '8px',
            resize: 'none',
            lineHeight: `${LINE_HEIGHT}px`,
            padding: '8px 12px',
            fontFamily: 'inherit',
            fontSize: '14px',
            border: '1px solid var(--borderColor-default, var(--color-border-default))',
            borderRadius: '6px',
            backgroundColor: 'var(--bgColor-input, var(--color-canvas-default))',
            color: 'var(--fgColor-default, var(--color-fg-default))',
            outline: 'none',
            boxSizing: 'border-box',
            overflowY: 'hidden',
          }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {(isStreaming || isWaitingForResponse) && !input.trim() ? (
            <Box
              as="button"
              type="button"
              onClick={onAbort}
              disabled={!isConnected || activeAgentId === null}
              aria-label="Stop"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: accent,
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                width: '32px',
                height: '32px',
                cursor: 'pointer',
                '&:hover:not([disabled])': { backgroundColor: accentHover },
                '&[disabled]': { opacity: 0.5, cursor: 'not-allowed' },
              }}
            >
              <SquareFillIcon size={16} />
            </Box>
          ) : (
            <Box
              as="button"
              type="submit"
              disabled={!isConnected || !input.trim() || activeAgentId === null}
              aria-label={isStreaming ? 'Queue message' : 'Send message'}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.teal,
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                width: '32px',
                height: '32px',
                cursor: 'pointer',
                '&:hover:not([disabled])': { backgroundColor: colors.tealHover },
                '&[disabled]': {
                  backgroundColor: 'neutral.muted',
                  color: 'fg.muted',
                  cursor: 'not-allowed',
                },
              }}
            >
              <ArrowUpIcon size={16} />
            </Box>
          )}
          {messageQueue.length > 0 && (
            <Box sx={{ fontSize: 0, color: 'fg.muted' }}>
              {messageQueue.length} message{messageQueue.length > 1 ? 's' : ''} queued
            </Box>
          )}
          {provider && <Box sx={{ fontSize: 0, color: 'fg.muted', ml: 'auto' }}>{provider}</Box>}
          {contextPercent !== null && (
            <Box
              sx={{
                fontSize: 0,
                color: 'fg.muted',
                ml: provider ? 0 : 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                role="img"
                aria-label={`${Math.round(contextPercent)}% context used`}
              >
                <circle
                  cx="8"
                  cy="8"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.3"
                  strokeWidth="2"
                />
                <circle
                  cx="8"
                  cy="8"
                  r="7"
                  fill="none"
                  stroke={ctxColor}
                  strokeWidth="2"
                  strokeDasharray={`${(contextPercent / 100) * 44} 44`}
                  strokeLinecap="round"
                  transform="rotate(-90 8 8)"
                />
              </svg>
              {Math.round(contextPercent)}% used
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
