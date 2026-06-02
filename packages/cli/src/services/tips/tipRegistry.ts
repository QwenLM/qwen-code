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
    content:
      'Context near hard limit — auto-compact will force on next send. Consider /clear if you want to start fresh.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
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

  // DataWorks usage examples (priority 75 to show before qwen-code native tips)
  {
    id: 'dw-identity',
    content:
      '👤 Identity: "Help me verify my identity and permissions in DataWorks?"',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 75,
  },
  {
    id: 'dw-analysis',
    content:
      '📊 Analysis: "Analyze the newly created nodes in the dataworks_analyze workspace in the past week and what they are doing?"',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 75,
  },
  {
    id: 'dw-governance',
    content:
      '🧹 Governance: "In the dataworks_analyze workspace, help me find nodes that were created long ago but have never been published."',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 75,
  },
  {
    id: 'dw-troubleshooting',
    content:
      '🔍 Troubleshooting: "The data in dwd_is_it_software_released_df and ads_is_it_sfw_moni_key_released_recycled_df are inconsistent, both have upstream ods_ism_it_software_key_released_df. Help me check what is different in their logic?"',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 75,
  },
  {
    id: 'dw-fix',
    content:
      '🛠️ Fix: "In the employee table my_project.ods_emp_info_d, the department data for employee EMP001 is empty. Help me troubleshoot the cause and provide fix suggestions."',
    trigger: 'startup',
    isRelevant: () => true,
    cooldownPrompts: 0,
    priority: 75,
  },
];
