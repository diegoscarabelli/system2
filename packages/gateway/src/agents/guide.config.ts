/**
 * Guide Agent Configuration
 *
 * Defines the LLM providers and models available for the Guide agent.
 */

export interface ModelOption {
  value: string;
  label: string;
  hint: string;
}

export interface ProviderConfig {
  anthropic: ModelOption[];
  openai: ModelOption[];
  google: ModelOption[];
}

/**
 * Available LLM models for the Guide agent.
 * Each provider has multiple model options with pricing and capability descriptions.
 */
export const GUIDE_MODEL_OPTIONS: ProviderConfig = {
  anthropic: [
    {
      value: 'claude-haiku-4-5',
      label: 'Haiku 4.5',
      hint: '$1/$5/M tokens • Fast & efficient, best for simple tasks',
    },
    {
      value: 'claude-sonnet-4-5',
      label: 'Sonnet 4.5 (Recommended)',
      hint: '$3/$15/M tokens • Balanced intelligence & cost',
    },
    {
      value: 'claude-opus-4-5',
      label: 'Opus 4.5',
      hint: '$5/$25/M tokens • Flagship performance for complex reasoning',
    },
  ],
  openai: [
    {
      value: 'gpt-4o-mini',
      label: 'GPT-4o-mini',
      hint: '$0.15/$0.60/M tokens • Ultra-cheap for simple tasks',
    },
    {
      value: 'gpt-4o',
      label: 'GPT-4o (Recommended)',
      hint: '$2.50/$10/M tokens • Best balance of capability & cost',
    },
    {
      value: 'o3-mini',
      label: 'o3-mini',
      hint: '$1.10/$4.40/M tokens • Advanced reasoning',
    },
  ],
  google: [
    {
      value: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      hint: '$0.15/$0.60/M tokens • Fast & cheap for simple tasks',
    },
    {
      value: 'gemini-3.1-pro',
      label: 'Gemini 3.1 Pro (Recommended)',
      hint: '$2/$12/M tokens • 77% on ARC-AGI, best value',
    },
  ],
};
