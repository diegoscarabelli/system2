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
import { useAccentColors } from '../theme/useAccentColors';

// Brain loader - rotating brain with sequential dots
function BrainLoader() {
  const { accent } = useAccentColors();
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
            color: accent,
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
            color: accent,
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
            color: accent,
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

// Parse JSON tool data into readable key: value lines
function formatToolData(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return raw;
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
  } catch {
    return raw;
  }
}

// Extract a brief summary from tool input JSON for inline display
function toolSummary(_name: string, input?: string): string {
  if (!input) return '';
  try {
    const obj = JSON.parse(input);
    // Pick the most descriptive field per tool
    const value = obj.command || obj.path || obj.sql || obj.query || '';
    if (!value) return '';
    const text = String(value).trim();
    // Truncate long values
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  } catch {
    return '';
  }
}

// Tool call display component (collapsible)
function ToolCallItem({ tc }: { tc: ToolCall }) {
  const isRunning = tc.status === 'running';
  const [collapsed, setCollapsed] = useState(false);
  const { highlight } = useAccentColors();
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
            color: highlight,
          }}
        >
          {isRunning ? '⚙️ ' : '✓ '}
          {tc.name}
        </Text>
        {toolSummary(tc.name, tc.input) && (
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{toolSummary(tc.name, tc.input)}</Text>
        )}
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
      {!collapsed && hasContent && (
        <Box
          sx={{
            marginTop: 1,
            border: '1px solid',
            borderColor: 'border.muted',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          {tc.input && (
            <Box sx={{ display: 'flex', gap: 2, padding: 2 }}>
              <Text
                sx={{
                  fontSize: 0,
                  fontWeight: 'semibold',
                  color: 'fg.muted',
                  flexShrink: 0,
                  width: '28px',
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
                  flex: 1,
                }}
              >
                {formatToolData(tc.input)}
              </Text>
            </Box>
          )}
          {tc.input && tc.result && (
            <Box sx={{ borderTop: '1px solid', borderColor: 'border.muted' }} />
          )}
          {tc.result && (
            <Box sx={{ display: 'flex', gap: 2, padding: 2 }}>
              <Text
                sx={{
                  fontSize: 0,
                  fontWeight: 'semibold',
                  color: 'fg.muted',
                  flexShrink: 0,
                  width: '28px',
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
                  flex: 1,
                }}
              >
                {tc.result}
              </Text>
            </Box>
          )}
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
  const { highlight } = useAccentColors();
  if (event.type === 'thinking') {
    return <ThinkingBlock thinking={event.data} />;
  }

  // Tool call
  const tc = event.data;
  return (
    <TimelineItem dotColor={highlight} pulse={tc.status === 'running'} isLast={isLast}>
      <ToolCallItem tc={tc} />
    </TimelineItem>
  );
}

// Render an assistant message with its turn events in chronological order
function AssistantMessageBlock({ message, isLast }: { message: Message; isLast: boolean }) {
  const { accent } = useAccentColors();
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
      <TimelineItem dotColor={accent} isLast={isLast}>
        <Text
          sx={{
            fontWeight: 'semibold',
            fontSize: 0,
            color: accent,
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
  const { accent } = useAccentColors();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const hasCurrentActivity =
    currentAssistantMessage || currentTurnEvents.length > 0 || isWaitingForResponse;

  // Track whether user is near the bottom of the scroll container
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 80; // px from bottom to consider "at bottom"
    const handleScroll = () => {
      isNearBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const completedToolCalls = currentTurnEvents.filter(
    (e) => e.type === 'tool_call' && e.data.status === 'completed'
  ).length;
  const scrollTrigger =
    messages.length +
    currentTurnEvents.length +
    completedToolCalls +
    (currentAssistantMessage ? 1 : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollTrigger drives auto-scroll on new content
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [scrollTrigger]);

  return (
    <Box
      ref={scrollContainerRef}
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
        <TimelineItem dotColor={accent} pulse isLast>
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
        <TimelineItem dotColor={accent} pulse isLast>
          <Text
            sx={{
              fontWeight: 'semibold',
              fontSize: 0,
              color: accent,
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
