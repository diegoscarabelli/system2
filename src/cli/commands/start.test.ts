import { describe, expect, it } from 'vitest';
import type { LlmConfig } from '../../shared/index.js';
import { formatTierBanner } from './start.js';

describe('formatTierBanner', () => {
  it('shows only OAuth line when api-keys has no provider keys', () => {
    // Mirrors the synthesized shape onboard writes when the user skips
    // api-keys: primary is set (defaulted to oauth primary) but no
    // provider in `providers` has any keys. The banner must NOT
    // advertise an api-keys tier in this state.
    const llm: LlmConfig = {
      primary: 'github-copilot',
      fallback: [],
      providers: { 'github-copilot': { keys: [] } },
      oauth: { primary: 'github-copilot', fallback: ['anthropic'], providers: {} },
    };
    expect(formatTierBanner(llm)).toEqual(['  OAuth tier:   github-copilot → anthropic']);
  });

  it('shows only api-keys line when no oauth tier is set', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: ['openai'],
      providers: {
        anthropic: { keys: [{ key: 'sk-ant', label: 'main' }] },
        openai: { keys: [{ key: 'sk-oai', label: 'main' }] },
      },
    };
    expect(formatTierBanner(llm)).toEqual(['  API key tier: anthropic → openai']);
  });

  it('shows both lines with full failover chains when both tiers are configured', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: ['google'],
      providers: {
        anthropic: { keys: [{ key: 'sk-ant', label: 'main' }] },
        google: { keys: [{ key: 'gk', label: 'main' }] },
      },
      oauth: {
        primary: 'github-copilot',
        fallback: ['anthropic', 'openai-codex'],
        providers: {},
      },
    };
    expect(formatTierBanner(llm)).toEqual([
      '  OAuth tier:   github-copilot → anthropic → openai-codex',
      '  API key tier: anthropic → google',
    ]);
  });

  it('returns empty array when neither tier has credentials', () => {
    // Config edited so all api-keys are empty and no oauth — start.ts
    // uses an empty result to print a friendly error and exit.
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: [],
      providers: { anthropic: { keys: [] } },
    };
    expect(formatTierBanner(llm)).toEqual([]);
  });

  it('omits arrow when fallback is empty (single-provider chain)', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: [],
      providers: {},
      oauth: { primary: 'anthropic', fallback: [], providers: {} },
    };
    expect(formatTierBanner(llm)).toEqual(['  OAuth tier:   anthropic']);
  });
});
