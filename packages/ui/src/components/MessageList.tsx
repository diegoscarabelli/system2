/**
 * Message List Component
 *
 * Displays the conversation history with a timeline-style UI.
 * Preserves chronological order of thinking blocks and tool calls.
 */

import { Box, Text } from '@primer/react';
import { Fragment, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  type Message,
  type ThinkingBlock as ThinkingBlockType,
  type ToolCall,
  type TurnEvent,
  useChatStore,
} from '../stores/chat';
import { colors } from '../theme/colors';

// Brain loader - rotating brain with sequential dots
function BrainLoader() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Text
        sx={{
          fontSize: 2,
          display: 'inline-block',
          animation: 'spin 2s linear infinite',
          '@keyframes spin': {
            '0%': { transform: 'rotate(0deg)' },
            '100%': { transform: 'rotate(360deg)' },
          },
        }}
      >
        🧠
      </Text>
      <Box sx={{ display: 'flex', gap: '2px' }}>
        <Text
          sx={{
            fontSize: 1,
            color: colors.amber,
            animation: 'dot1 1.5s ease-in-out infinite',
            '@keyframes dot1': {
              '0%, 20%': { opacity: 0 },
              '25%, 100%': { opacity: 1 },
            },
          }}
        >
          •
        </Text>
        <Text
          sx={{
            fontSize: 1,
            color: colors.amber,
            animation: 'dot2 1.5s ease-in-out infinite',
            '@keyframes dot2': {
              '0%, 40%': { opacity: 0 },
              '45%, 100%': { opacity: 1 },
            },
          }}
        >
          •
        </Text>
        <Text
          sx={{
            fontSize: 1,
            color: colors.amber,
            animation: 'dot3 1.5s ease-in-out infinite',
            '@keyframes dot3': {
              '0%, 60%': { opacity: 0 },
              '65%, 95%': { opacity: 1 },
              '100%': { opacity: 0 },
            },
          }}
        >
          •
        </Text>
      </Box>
    </Box>
  );
}

// Markdown wrapper with styling
function MarkdownContent({ content, muted }: { content: string; muted?: boolean }) {
  return (
    <Box
      sx={{
        fontSize: 1,
        color: muted ? 'fg.muted' : 'fg.default',
        fontStyle: muted ? 'italic' : 'normal',
        '& p': { margin: 0, marginBottom: 2 },
        '& p:last-child': { marginBottom: 0 },
        '& h1, & h2, & h3, & h4, & h5, & h6': {
          marginTop: 3,
          marginBottom: 2,
          fontWeight: 'bold',
        },
        '& h1': { fontSize: 3 },
        '& h2': { fontSize: 2 },
        '& h3': { fontSize: 1, fontWeight: 'semibold' },
        '& ul, & ol': { marginTop: 1, marginBottom: 2, paddingLeft: 3 },
        '& li': { marginBottom: 1 },
        '& code': {
          fontFamily: 'mono',
          backgroundColor: 'neutral.muted',
          padding: '2px 4px',
          borderRadius: 1,
          fontSize: 0,
        },
        '& pre': {
          backgroundColor: 'neutral.muted',
          padding: 2,
          borderRadius: 2,
          overflow: 'auto',
          marginTop: 2,
          marginBottom: 2,
        },
        '& pre code': {
          backgroundColor: 'transparent',
          padding: 0,
        },
        '& strong': { fontWeight: 'bold' },
        '& em': { fontStyle: 'italic' },
        '& hr': {
          border: 'none',
          borderTop: '1px solid',
          borderColor: 'border.muted',
          marginTop: 3,
          marginBottom: 3,
        },
        '& a': { color: 'accent.fg' },
        '& blockquote': {
          borderLeft: '3px solid',
          borderColor: 'border.default',
          paddingLeft: 2,
          marginLeft: 0,
          color: 'fg.muted',
        },
      }}
    >
      <Markdown>{content}</Markdown>
    </Box>
  );
}

// Timeline dot component
function TimelineDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <Box
      sx={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink: 0,
        animation: pulse ? 'pulse 1.5s ease-in-out infinite' : undefined,
        '@keyframes pulse': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.4 },
        },
      }}
    />
  );
}

// Timeline item wrapper
function TimelineItem({
  children,
  dotColor,
  pulse,
  isLast,
}: {
  children: React.ReactNode;
  dotColor: string;
  pulse?: boolean;
  isLast?: boolean;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 2, position: 'relative' }}>
      {/* Vertical line and dot */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: '6px',
        }}
      >
        <TimelineDot color={dotColor} pulse={pulse} />
        {!isLast && (
          <Box
            sx={{
              width: '1px',
              flex: 1,
              backgroundColor: 'border.muted',
              marginTop: 1,
            }}
          />
        )}
      </Box>
      {/* Content */}
      <Box sx={{ flex: 1, paddingBottom: 3, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

// Tool call display component (collapsible)
function ToolCallItem({ tc }: { tc: ToolCall }) {
  const isRunning = tc.status === 'running';
  const [collapsed, setCollapsed] = useState(false);
  const hasContent = tc.input || tc.result;

  return (
    <Box>
      <Box
        onClick={() => hasContent && setCollapsed(!collapsed)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          cursor: hasContent ? 'pointer' : 'default',
          '&:hover': hasContent ? { opacity: 0.8 } : {},
        }}
      >
        <Text
          sx={{
            fontSize: 0,
            fontWeight: 'semibold',
            color: colors.magenta,
          }}
        >
          {isRunning ? '⚙️ ' : '✓ '}
          {tc.name}
        </Text>
        {hasContent && (
          <Text
            sx={{
              fontSize: 0,
              color: 'fg.muted',
              transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
              lineHeight: 1,
            }}
          >
            ^
          </Text>
        )}
      </Box>
      {!collapsed && tc.input && (
        <Box sx={{ marginTop: 1 }}>
          <Text
            sx={{
              fontSize: 0,
              fontWeight: 'semibold',
              color: 'fg.muted',
              marginBottom: 1,
              display: 'block',
            }}
          >
            IN
          </Text>
          <Text
            as="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'mono',
              fontSize: 0,
              color: 'fg.muted',
              margin: 0,
              maxHeight: '100px',
              overflow: 'auto',
            }}
          >
            {tc.input}
          </Text>
        </Box>
      )}
      {!collapsed && tc.result && (
        <Box sx={{ marginTop: 1 }}>
          <Text
            sx={{
              fontSize: 0,
              fontWeight: 'semibold',
              color: 'fg.muted',
              marginBottom: 1,
              display: 'block',
            }}
          >
            OUT
          </Text>
          <Text
            as="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'mono',
              fontSize: 0,
              color: 'fg.muted',
              margin: 0,
              maxHeight: '150px',
              overflow: 'auto',
            }}
          >
            {tc.result}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// Thinking block component (collapsible even while streaming)
function ThinkingBlock({ thinking }: { thinking: ThinkingBlockType }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <TimelineItem dotColor={colors.gray} pulse={thinking.isStreaming}>
      <Box
        onClick={() => setCollapsed(!collapsed)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          cursor: 'pointer',
          '&:hover': { opacity: 0.8 },
        }}
      >
        <Text
          sx={{
            fontWeight: 'semibold',
            fontSize: 0,
            color: 'fg.muted',
          }}
        >
          {thinking.isStreaming ? 'Thinking...' : 'Thought'}
        </Text>
        <Text
          sx={{
            fontSize: 0,
            color: 'fg.muted',
            transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            lineHeight: 1,
          }}
        >
          ^
        </Text>
      </Box>
      {!collapsed && (
        <Box sx={{ marginTop: 1 }}>
          <MarkdownContent content={thinking.content} muted />
        </Box>
      )}
    </TimelineItem>
  );
}

// Render a single turn event (thinking or tool call)
function TurnEventItem({ event, isLast }: { event: TurnEvent; isLast?: boolean }) {
  if (event.type === 'thinking') {
    return <ThinkingBlock thinking={event.data} />;
  }

  // Tool call
  const tc = event.data;
  return (
    <TimelineItem dotColor={colors.magenta} pulse={tc.status === 'running'} isLast={isLast}>
      <ToolCallItem tc={tc} />
    </TimelineItem>
  );
}

// Render an assistant message with its turn events in chronological order
function AssistantMessageBlock({ message, isLast }: { message: Message; isLast: boolean }) {
  const hasTurnEvents = message.turnEvents && message.turnEvents.length > 0;

  return (
    <Fragment>
      {/* Turn events in chronological order (thinking blocks and tool calls) */}
      {hasTurnEvents &&
        message.turnEvents?.map((event) => (
          <TurnEventItem
            key={event.type === 'thinking' ? event.data.id : event.data.id}
            event={event}
          />
        ))}

      {/* Response */}
      <TimelineItem dotColor={colors.amber} isLast={isLast}>
        <Text
          sx={{
            fontWeight: 'semibold',
            fontSize: 0,
            color: colors.amber,
            marginBottom: 1,
          }}
        >
          Guide
        </Text>
        <MarkdownContent content={message.content} />
      </TimelineItem>
    </Fragment>
  );
}

export function MessageList() {
  const { messages, currentAssistantMessage, currentTurnEvents, isWaitingForResponse } =
    useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const hasCurrentActivity =
    currentAssistantMessage || currentTurnEvents.length > 0 || isWaitingForResponse;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        padding: 3,
      }}
    >
      {messages.length === 0 && !hasCurrentActivity && (
        <Box
          sx={{
            textAlign: 'center',
            color: 'fg.muted',
            paddingTop: 4,
            fontSize: 0,
          }}
        >
          Ask the Guide to help configure your data infrastructure.
        </Box>
      )}

      {/* Message history */}
      {messages.map((message, idx) => {
        const isLastMessage = idx === messages.length - 1 && !hasCurrentActivity;

        if (message.role === 'user') {
          return (
            <TimelineItem key={message.id} dotColor={colors.teal} isLast={isLastMessage}>
              <Text
                sx={{
                  fontWeight: 'semibold',
                  fontSize: 0,
                  color: colors.teal,
                  marginBottom: 1,
                }}
              >
                You
              </Text>
              <Text
                as="pre"
                sx={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'mono',
                  fontSize: 1,
                  margin: 0,
                }}
              >
                {message.content}
              </Text>
            </TimelineItem>
          );
        }

        // Assistant message with embedded turn events
        return <AssistantMessageBlock key={message.id} message={message} isLast={isLastMessage} />;
      })}

      {/* Waiting for response indicator */}
      {isWaitingForResponse && currentTurnEvents.length === 0 && !currentAssistantMessage && (
        <TimelineItem dotColor={colors.amber} pulse isLast>
          <BrainLoader />
        </TimelineItem>
      )}

      {/* Current streaming: turn events in chronological order */}
      {currentTurnEvents.map((event, idx) => (
        <TurnEventItem
          key={event.type === 'thinking' ? event.data.id : event.data.id}
          event={event}
          isLast={idx === currentTurnEvents.length - 1 && !currentAssistantMessage}
        />
      ))}

      {/* Current streaming: response */}
      {currentAssistantMessage && (
        <TimelineItem dotColor={colors.amber} pulse isLast>
          <Text
            sx={{
              fontWeight: 'semibold',
              fontSize: 0,
              color: colors.amber,
              marginBottom: 1,
            }}
          >
            Guide
          </Text>
          <MarkdownContent content={currentAssistantMessage} />
        </TimelineItem>
      )}

      <div ref={messagesEndRef} />
    </Box>
  );
}
