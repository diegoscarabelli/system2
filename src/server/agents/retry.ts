/**
 * Retry Utility
 *
 * Implements exponential backoff with jitter for API calls.
 * Handles different error types with appropriate retry strategies.
 */

export interface RetryConfig {
  /** Base delay in milliseconds (default: 1000) */
  baseDelay: number;
  /** Maximum delay cap in milliseconds (default: 90000) */
  maxDelay: number;
  /** Maximum retries for rate limit errors (default: 7) */
  maxRateLimitRetries: number;
  /** Maximum retries for transient errors like 503 (default: 2) */
  maxTransientRetries: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelay: 1000,
  maxDelay: 90000,
  maxRateLimitRetries: 7,
  maxTransientRetries: 2,
};

/**
 * Error categories that determine retry behavior.
 */
export type ErrorCategory =
  | 'auth' // 401, 403 - immediate failover
  | 'rate_limit' // 429 - exponential retry, then failover
  | 'transient' // 500, 503, timeout - brief retry, then failover
  | 'context_overflow' // 400 with token limit exceeded - compact and retry
  | 'client' // 400 - no retry, immediate failover
  | 'unknown'; // unexpected - treat as transient

/**
 * Categorize an error based on HTTP status code or error type.
 */
export function categorizeError(error: unknown): ErrorCategory {
  // Extract status code from various error formats
  const statusCode = extractStatusCode(error);

  // Check for context overflow before status code classification (400 that is recoverable)
  const errorMessage = extractErrorMessage(error).toLowerCase();
  if (isContextOverflow(errorMessage)) {
    return 'context_overflow';
  }

  if (statusCode) {
    switch (statusCode) {
      case 400:
        return 'client';
      case 401:
      case 403:
        return 'auth';
      case 429:
        return 'rate_limit';
      case 500:
      case 502:
      case 503:
      case 504:
        return 'transient';
      default:
        if (statusCode >= 400 && statusCode < 500) {
          return 'client';
        }
        if (statusCode >= 500) {
          return 'transient';
        }
    }
  }

  // Check for timeout/network errors
  if (
    errorMessage.includes('timeout') ||
    errorMessage.includes('econnrefused') ||
    errorMessage.includes('enotfound') ||
    errorMessage.includes('network')
  ) {
    return 'transient';
  }

  return 'unknown';
}

/**
 * Patterns that indicate a wire-size overflow — the request payload is too large to
 * transmit, regardless of token count. Errors matching these patterns cannot be
 * recovered by compaction or provider failover (the same oversized bytes would be
 * replayed). Pending deliveries should be dropped rather than retried.
 *
 * Distinct from TOKEN_OVERFLOW_PATTERNS (e.g. "input token count exceeds maximum"),
 * which ARE recoverable via compaction.
 *
 * Checked against the lowercased error message.
 */
const WIRE_SIZE_PATTERNS: RegExp[] = [
  // HTTP 413 from Anthropic and other providers
  /request exceeds the maximum size/,
  /input size exceeds.*mb/,
  /payload too large/,
  /request too large/,
  /body too large/,
  /exceeds maximum size/,
  // Anthropic OAuth long-context misclassifier (Pro/Max, post-March-2026):
  // fires on requests over a soft size threshold — smaller request will pass.
  /extra usage is required for long context/,
  /long context request/,
];

/**
 * Patterns that indicate a token-window overflow. These ARE recoverable via compaction
 * (the same bytes, stripped down to fit, will succeed).
 *
 * Checked against the lowercased error message.
 */
const TOKEN_OVERFLOW_PATTERNS: RegExp[] = [
  // Google: "The input token count (N) exceeds the maximum number of tokens allowed (N)"
  /input token count.*exceeds.*maximum/,
  // OpenAI, Groq, Cerebras, OpenRouter, Mistral:
  //   "This model's maximum context length is N tokens"
  //   "This endpoint's maximum context length is N tokens" (OpenRouter)
  //   "too large for model with N maximum context length" (Mistral)
  /maximum context length/,
  // Anthropic: "prompt is too long: N tokens > N maximum"
  /prompt is too long.*tokens/,
  // xAI/Grok: "This model's maximum prompt length is N but the request contains M tokens"
  /maximum prompt length/,
  // OpenAI Responses API: "Your input exceeds the context window of this model"
  /exceeds the context window/,
  // Providers that surface the error code verbatim in the message
  /context.?length.?exceeded/,
];

/**
 * Check if an error message indicates a wire-size overflow — a payload that is too
 * large to transmit, regardless of how many tokens it represents. These errors cannot
 * be recovered by compaction or provider failover (the same oversized bytes would be
 * replayed). Pending deliveries should be dropped rather than retried.
 *
 * Distinct from token-window overflows (e.g. "input token count exceeds maximum"),
 * which ARE recoverable via compaction.
 */
export function isWireSizeOverflow(message: string): boolean {
  const m = message.toLowerCase();
  return WIRE_SIZE_PATTERNS.some((p) => p.test(m));
}

/**
 * Check if an error message indicates context window overflow.
 * Matches patterns from all supported providers (both wire-size and token-window).
 */
function isContextOverflow(message: string): boolean {
  return (
    TOKEN_OVERFLOW_PATTERNS.some((p) => p.test(message)) ||
    WIRE_SIZE_PATTERNS.some((p) => p.test(message))
  );
}

/**
 * Extract HTTP status code from various error formats.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const err = error as Record<string, unknown>;

  // Direct status property
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.code === 'number' && err.code >= 100 && err.code < 600) return err.code;

  // Nested in response
  if (err.response && typeof err.response === 'object') {
    const response = err.response as Record<string, unknown>;
    if (typeof response.status === 'number') return response.status;
  }

  // Parse from error message (common in API errors)
  const message = extractErrorMessage(error);
  const match = message.match(/\b(4\d{2}|5\d{2})\b/);
  if (match) return parseInt(match[1], 10);

  return undefined;
}

/**
 * Extract error message from various error formats.
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (typeof err.message === 'string') return err.message;
    if (typeof err.errorMessage === 'string') return err.errorMessage;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Calculate delay with exponential backoff and jitter.
 * Formula: min(baseDelay * 2^attempt + jitter, maxDelay)
 */
export function calculateDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  const exponentialDelay = config.baseDelay * 2 ** attempt;
  // Add random jitter (0-25% of delay) to avoid thundering herd
  const jitter = Math.random() * exponentialDelay * 0.25;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

/**
 * Sleep for the specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if we should retry based on error category and attempt count.
 */
export function shouldRetry(
  category: ErrorCategory,
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): boolean {
  switch (category) {
    case 'auth':
    case 'client':
    case 'context_overflow':
      // Never retry auth, client, or context overflow errors (overflow needs compaction, not retry)
      return false;
    case 'rate_limit':
      return attempt < config.maxRateLimitRetries;
    case 'transient':
    case 'unknown':
      return attempt < config.maxTransientRetries;
  }
}

/**
 * Determine if we should failover to the next provider/key.
 */
export function shouldFailover(category: ErrorCategory, retriesExhausted: boolean): boolean {
  switch (category) {
    case 'auth':
      // Immediate failover for auth errors
      return true;
    case 'rate_limit':
    case 'transient':
    case 'unknown':
      // Failover only after retries exhausted
      return retriesExhausted;
    case 'client':
      // Immediate failover for client errors (e.g., credit balance too low).
      // Key goes into cooldown so the system recovers if the user fixes the issue.
      return true;
    case 'context_overflow':
      // Never failover for context overflow (another provider has the same context)
      return false;
  }
}
