/**
 * Color Palette
 *
 * Centralized color definitions for the System2 UI.
 */

export const colors = {
  /** User messages and send button */
  user: '#00aaba',
  userHover: '#009aa8',

  /** Guide (assistant) messages, stop button, loading indicator */
  guide: '#ffb444',
  guideHover: '#e6a23c',

  /** Tool call indicators */
  tool: '#fd2ef5',

  /** Thinking block indicators */
  thinking: '#8b949e',

  /** Conductor agent */
  conductor: '#066a7c',

  /** Reviewer agent */
  reviewer: '#ec4a2c',

  /** Narrator agent */
  narrator: '#b61899',
  narratorLight: '#c756ad',

  /** Neutral / muted */
  neutral: '#424242',

  /** Context usage thresholds */
  contextOk: '#3fb950',
  contextWarn: '#d29922',
  contextCritical: '#f85149',
} as const;
