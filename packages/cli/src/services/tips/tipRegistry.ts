/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contextual tip registry — defines tips, their conditions, and display rules.
 */

import { type CompactionThresholds } from '@qwen-code/qwen-code-core';

export type TipTrigger = 'startup' | 'post-response';

export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
  /**
   * Three-tier auto-compaction thresholds, computed by callers via
   * `computeThresholds(contextWindowSize)`. Optional for backward compat;
   * context-* tip checks return false when missing.
   */
  thresholds?: CompactionThresholds;
}

export interface ContextualTip {
  id: string;
  content: string;
  trigger: TipTrigger;
  isRelevant: (ctx: TipContext) => boolean;
  cooldownPrompts: number;
  priority: number;
}

export const tipRegistry: ContextualTip[] = [
  // --- Post-response contextual tips (priority: higher = more urgent) ---
  {
    id: 'context-critical',
    // R6.8 / R7.10: tip fires post-response. We don't know from this
    // call site whether (a) hard-tier rescue ran successfully and
    // shrank the context, (b) it ran but failed/NOOP'd, or (c) it was
    // suppressed because `hardRescueFailureCount` hit
    // `MAX_CONSECUTIVE_FAILURES`. The earlier wording ("auto-compact
    // was forced on this turn") was wrong in case (c); the still
    // earlier ("will force on next send") was wrong in case (a).
    // Neutral, actionable wording is correct across all three.
    content: 'Context near hard limit. Run /compress or /clear to free space.',
    trigger: 'post-response',
    // R9.5: gate on `hard > auto` mirroring `currentTier` in
    // contextCommand.ts. On small windows (e.g. 32K) `computeThresholds`
    // collapses `hard` to equal `auto`, leaving the critical band
    // degenerate — without this guard the tip fires at the auto
    // threshold while claiming "near hard limit" when there is no
    // distinct hard limit. The `context-high` tip in the band
    // `[auto, hard)` already covers small windows.
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.thresholds.hard > ctx.thresholds.auto &&
      ctx.lastPromptTokenCount >= ctx.thresholds.hard,
    cooldownPrompts: 3,
    priority: 100,
  },
  {
    id: 'context-high',
    content: 'Context is getting full. Use /compress to free up space.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.auto &&
      ctx.lastPromptTokenCount < ctx.thresholds.hard,
    cooldownPrompts: 5,
    priority: 90,
  },
  {
    id: 'compress-intro',
    content: 'Long conversation? /compress summarizes history to free context.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.warn &&
      ctx.lastPromptTokenCount < ctx.thresholds.auto &&
      ctx.sessionPromptCount > 5,
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
    id: 'approval-mode-win32',
    content:
      'You can switch permission mode quickly with Tab or /approval-mode.',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.platform === 'win32',
    cooldownPrompts: 0,
    priority: 50,
  },
  {
    id: 'approval-mode',
    content:
      'You can switch permission mode quickly with Shift+Tab or /approval-mode.',
    trigger: 'startup',
    isRelevant: (ctx) => ctx.platform !== 'win32',
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
  {
    id: 'compact-mode',
    content:
      'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 50,
  },
];
