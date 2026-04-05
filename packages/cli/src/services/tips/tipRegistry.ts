/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contextual tip registry — defines tips, their conditions, and display rules.
 */

export type TipTrigger = 'startup' | 'post-response';

export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  compressionThreshold: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
}

export interface ContextualTip {
  id: string;
  content: string;
  trigger: TipTrigger;
  isRelevant: (ctx: TipContext) => boolean;
  cooldownPrompts: number;
  priority: number;
}

/**
 * Default context window size fallback (matches chatCompressionService).
 */
const DEFAULT_TOKEN_LIMIT = 1_048_576;

export function getContextUsagePercent(ctx: TipContext): number {
  const windowSize = ctx.contextWindowSize || DEFAULT_TOKEN_LIMIT;
  return (ctx.lastPromptTokenCount / windowSize) * 100;
}

export const tipRegistry: ContextualTip[] = [
  // --- Post-response contextual tips (priority: higher = more urgent) ---
  {
    id: 'context-critical',
    content:
      'Context is almost full! Run /compress now or start /new to continue.',
    trigger: 'post-response',
    isRelevant: (ctx) => getContextUsagePercent(ctx) >= 95,
    cooldownPrompts: 3,
    priority: 100,
  },
  {
    id: 'context-high',
    content: 'Context is getting full. Use /compress to free up space.',
    trigger: 'post-response',
    isRelevant: (ctx) => {
      const pct = getContextUsagePercent(ctx);
      return pct >= 80 && pct < 95;
    },
    cooldownPrompts: 5,
    priority: 90,
  },
  {
    id: 'compress-intro',
    content: 'Long conversation? /compress summarizes history to free context.',
    trigger: 'post-response',
    isRelevant: (ctx) => {
      const pct = getContextUsagePercent(ctx);
      return pct >= 50 && pct < 80 && ctx.sessionPromptCount > 5;
    },
    cooldownPrompts: 10,
    priority: 50,
  },

  // --- Startup tips ---
  {
    id: 'new-user-slash',
    content:
      'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.sessionCount < 5,
    cooldownPrompts: 0,
    priority: 70,
  },
  {
    id: 'new-user-qwenmd',
    content: 'Add a QWEN.md file to give Qwen Code persistent project context.',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.sessionCount < 10,
    cooldownPrompts: 0,
    priority: 70,
  },
  {
    id: 'new-user-resume',
    content:
      'You can resume a previous conversation by running qwen --continue or qwen --resume.',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.sessionCount < 10,
    cooldownPrompts: 0,
    priority: 70,
  },
  {
    id: 'shell-commands',
    content:
      'You can run any shell commands from Qwen Code using ! (e.g. !ls).',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.sessionCount < 15,
    cooldownPrompts: 0,
    priority: 70,
  },
  {
    id: 'compress-startup',
    content:
      'Use /compress when the conversation gets long to summarize history and free up context.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
  {
    id: 'approval-mode',
    content:
      process.platform === 'win32'
        ? 'You can switch permission mode quickly with Tab or /approval-mode.'
        : 'You can switch permission mode quickly with Shift+Tab or /approval-mode.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
  {
    id: 'insight-command',
    content:
      'Try /insight to generate personalized insights from your chat history.',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.sessionCount > 20,
    cooldownPrompts: 0,
    priority: 70,
  },
  {
    id: 'btw-command',
    content:
      'Use /btw to ask a quick side question without disrupting the conversation.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
  {
    id: 'clear-new',
    content:
      'Start a fresh idea with /clear or /new; the previous session stays available in history.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
  {
    id: 'bug-report',
    content:
      'Use /bug to submit issues to the maintainers when something goes off.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
  {
    id: 'auth-switch',
    content: 'Switch auth type quickly with /auth.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
];
