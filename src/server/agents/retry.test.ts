import { describe, expect, it } from 'vitest';
import {
  calculateDelay,
  categorizeError,
  DEFAULT_RETRY_CONFIG,
  extractErrorMessage,
  shouldFailover,
  shouldRetry,
} from './retry.js';

describe('categorizeError', () => {
  it('returns "client" for 400 status', () => {
    expect(categorizeError({ status: 400 })).toBe('client');
  });

  it('returns "auth" for 401 status', () => {
    expect(categorizeError({ status: 401 })).toBe('auth');
  });

  it('returns "auth" for 403 status', () => {
    expect(categorizeError({ status: 403 })).toBe('auth');
  });

  it('returns "rate_limit" for 429 status', () => {
    expect(categorizeError({ status: 429 })).toBe('rate_limit');
  });

  it('returns "transient" for 500/502/503/504 status', () => {
    for (const code of [500, 502, 503, 504]) {
      expect(categorizeError({ status: code })).toBe('transient');
    }
  });

  it('returns "client" for unknown 4xx', () => {
    expect(categorizeError({ status: 405 })).toBe('client');
    expect(categorizeError({ status: 422 })).toBe('client');
  });

  it('returns "transient" for unknown 5xx', () => {
    expect(categorizeError({ status: 599 })).toBe('transient');
  });

  it('extracts status from statusCode property', () => {
    expect(categorizeError({ statusCode: 429 })).toBe('rate_limit');
  });

  it('extracts status from nested response.status', () => {
    expect(categorizeError({ response: { status: 503 } })).toBe('transient');
  });

  it('extracts status from error message string', () => {
    expect(categorizeError(new Error('Request failed with status 429'))).toBe('rate_limit');
  });

  it('returns "transient" for timeout errors', () => {
    expect(categorizeError(new Error('Request timeout'))).toBe('transient');
  });

  it('returns "transient" for ECONNREFUSED', () => {
    expect(categorizeError(new Error('connect ECONNREFUSED'))).toBe('transient');
  });

  it('returns "transient" for ENOTFOUND', () => {
    expect(categorizeError(new Error('getaddrinfo ENOTFOUND'))).toBe('transient');
  });

  it('returns "transient" for network errors', () => {
    expect(categorizeError(new Error('Network error'))).toBe('transient');
  });

  it('returns "unknown" for unrecognized errors', () => {
    expect(categorizeError(new Error('Something weird happened'))).toBe('unknown');
  });

  it('returns "unknown" for null/undefined', () => {
    expect(categorizeError(null)).toBe('unknown');
    expect(categorizeError(undefined)).toBe('unknown');
  });

  it('returns "context_overflow" for Google token limit errors', () => {
    const error = {
      message:
        'The input token count (1075988) exceeds the maximum number of tokens allowed (1048575).',
      code: 400,
    };
    expect(categorizeError(error)).toBe('context_overflow');
  });

  it('returns "context_overflow" for OpenAI context length errors', () => {
    expect(
      categorizeError(new Error('maximum context length is 128000 tokens, you requested 130000'))
    ).toBe('context_overflow');
  });

  it('returns "context_overflow" for Anthropic prompt too long errors', () => {
    expect(categorizeError(new Error('prompt is too long: 250000 tokens > 200000 maximum'))).toBe(
      'context_overflow'
    );
  });

  it('returns "context_overflow" for xAI/Grok maximum prompt length errors', () => {
    expect(
      categorizeError(
        new Error(
          "This model's maximum prompt length is 131072 but the request contains 136973 tokens."
        )
      )
    ).toBe('context_overflow');
  });

  it('returns "context_overflow" for OpenAI Responses API context window errors', () => {
    expect(
      categorizeError(
        new Error('Your input exceeds the context window of this model. Please adjust your input.')
      )
    ).toBe('context_overflow');
  });

  it('returns "context_overflow" when error code appears verbatim in message', () => {
    expect(categorizeError(new Error('context_length_exceeded: reduce your prompt'))).toBe(
      'context_overflow'
    );
  });

  it('returns "context_overflow" for Mistral token count errors', () => {
    expect(
      categorizeError(
        new Error(
          'Prompt contains 65673 tokens, too large for model with 32768 maximum context length'
        )
      )
    ).toBe('context_overflow');
  });

  it('returns "context_overflow" for OpenRouter endpoint context length errors', () => {
    expect(
      categorizeError(
        new Error(
          "This endpoint's maximum context length is 131072 tokens. However, you requested about 138956 tokens."
        )
      )
    ).toBe('context_overflow');
  });

  it('returns "client" for non-overflow 400 errors', () => {
    expect(categorizeError({ status: 400, message: 'Invalid request body' })).toBe('client');
  });

  it('returns "rate_limit" for token-per-minute limit errors (not context_overflow)', () => {
    expect(categorizeError({ status: 429, message: 'token per minute limit exceeded' })).toBe(
      'rate_limit'
    );
  });
});

describe('extractErrorMessage', () => {
  it('returns string errors directly', () => {
    expect(extractErrorMessage('plain error')).toBe('plain error');
  });

  it('returns Error.message', () => {
    expect(extractErrorMessage(new Error('test'))).toBe('test');
  });

  it('returns message from plain objects', () => {
    expect(extractErrorMessage({ message: 'obj error' })).toBe('obj error');
  });

  it('returns errorMessage from plain objects', () => {
    expect(extractErrorMessage({ errorMessage: 'alt error' })).toBe('alt error');
  });

  it('JSON-stringifies objects without message', () => {
    expect(extractErrorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it('stringifies primitives', () => {
    expect(extractErrorMessage(42)).toBe('42');
    expect(extractErrorMessage(true)).toBe('true');
  });
});

describe('calculateDelay', () => {
  it('returns baseDelay for attempt 0 (plus jitter)', () => {
    const delay = calculateDelay(0, DEFAULT_RETRY_CONFIG);
    // baseDelay=1000, jitter adds 0-25%, so range is [1000, 1250]
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it('doubles delay for each attempt', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, maxDelay: 100000 };
    const d0 = calculateDelay(0, config);
    const d1 = calculateDelay(1, config);
    const d2 = calculateDelay(2, config);
    // Each should roughly double (within jitter range)
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('caps at maxDelay', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, maxDelay: 5000 };
    const delay = calculateDelay(20, config);
    expect(delay).toBeLessThanOrEqual(5000);
  });
});

describe('shouldRetry', () => {
  it('never retries auth errors', () => {
    expect(shouldRetry('auth', 0)).toBe(false);
  });

  it('never retries client errors', () => {
    expect(shouldRetry('client', 0)).toBe(false);
  });

  it('never retries context_overflow errors', () => {
    expect(shouldRetry('context_overflow', 0)).toBe(false);
  });

  it('retries rate_limit up to maxRateLimitRetries', () => {
    expect(shouldRetry('rate_limit', 0)).toBe(true);
    expect(shouldRetry('rate_limit', 6)).toBe(true);
    expect(shouldRetry('rate_limit', 7)).toBe(false);
  });

  it('retries transient up to maxTransientRetries', () => {
    expect(shouldRetry('transient', 0)).toBe(true);
    expect(shouldRetry('transient', 1)).toBe(true);
    expect(shouldRetry('transient', 2)).toBe(false);
  });

  it('retries unknown as transient', () => {
    expect(shouldRetry('unknown', 0)).toBe(true);
    expect(shouldRetry('unknown', 2)).toBe(false);
  });

  it('respects custom config', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, maxRateLimitRetries: 1 };
    expect(shouldRetry('rate_limit', 0, config)).toBe(true);
    expect(shouldRetry('rate_limit', 1, config)).toBe(false);
  });
});

describe('shouldFailover', () => {
  it('immediately fails over on auth errors', () => {
    expect(shouldFailover('auth', false)).toBe(true);
    expect(shouldFailover('auth', true)).toBe(true);
  });

  it('immediately fails over on client errors', () => {
    expect(shouldFailover('client', false)).toBe(true);
    expect(shouldFailover('client', true)).toBe(true);
  });

  it('never fails over on context_overflow errors', () => {
    expect(shouldFailover('context_overflow', false)).toBe(false);
    expect(shouldFailover('context_overflow', true)).toBe(false);
  });

  it('fails over on rate_limit only when retries exhausted', () => {
    expect(shouldFailover('rate_limit', false)).toBe(false);
    expect(shouldFailover('rate_limit', true)).toBe(true);
  });

  it('fails over on transient only when retries exhausted', () => {
    expect(shouldFailover('transient', false)).toBe(false);
    expect(shouldFailover('transient', true)).toBe(true);
  });

  it('fails over on unknown only when retries exhausted', () => {
    expect(shouldFailover('unknown', false)).toBe(false);
    expect(shouldFailover('unknown', true)).toBe(true);
  });
});
