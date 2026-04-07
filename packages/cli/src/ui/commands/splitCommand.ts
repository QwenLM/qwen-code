/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  SmartTaskSplitter,
  ParallelTaskRunner,
} from '@qwen-code/qwen-code-core';
import type { SplitAnalysis, TaskSplit } from '@qwen-code/qwen-code-core';

/**
 * Format a task split for display.
 */
function formatTask(task: TaskSplit, index: number): string {
  const depInfo =
    task.dependencies.length > 0
      ? `\n   Dependencies: ${task.dependencies.join(', ')}`
      : '';
  const parallelIcon =
    task.dependencies.length === 0 ? '⚡' : '🔗';

  return `${parallelIcon} **${index + 1}. ${task.taskName}** \`${task.taskId}\`
   Mode: ${task.mode} | Sub-agent: ${task.subagent}
   Est. time: ${task.estimatedTimeMinutes} min${depInfo}`;
}

/**
 * Format a split analysis for display.
 */
function formatSplitAnalysis(analysis: SplitAnalysis): string {
  const lines = [
    `${analysis.parallelizable ? '⚡' : '🔗'} **Smart Task Split Analysis**`,
    '',
    `**Feature:** ${analysis.featureDescription}`,
    '',
    `**Reasoning:**`,
    analysis.reasoning,
    '',
    `**Parallelizable:** ${analysis.parallelizable ? 'Yes - tasks can run simultaneously' : 'No - tasks have dependencies'}`,
    `**Estimated total time:** ${analysis.estimatedTotalTime} minutes`,
    '',
    `**Suggested Tasks:** (${analysis.suggestedSplit.length})`,
    '',
  ];

  for (let i = 0; i < analysis.suggestedSplit.length; i++) {
    lines.push(formatTask(analysis.suggestedSplit[i], i));
    lines.push('');
  }

  if (analysis.alternativeSplits.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('**Alternative Splits:**');
    lines.push('');

    for (const alt of analysis.alternativeSplits) {
      lines.push(`**${alt.name}** (${alt.estimatedTotalTime} min)`);
      for (let i = 0; i < alt.tasks.length; i++) {
        const task = alt.tasks[i];
        const depInfo =
          task.dependencies.length > 0
            ? ` (depends on: ${task.dependencies.join(', ')})`
            : '';
        lines.push(`  - ${task.icon} ${task.taskName} — ${task.estimatedTimeMinutes} min${depInfo}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Module-level state for the split command.
 * In a full implementation, this would be managed by a service.
 */
let currentAnalysis: SplitAnalysis | null = null;

export const splitCommand: SlashCommand = {
  name: 'split',
  altNames: ['analyze'],
  get description() {
    return t(
      'analyze and split features into parallel tasks',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available',
      };
    }

    const trimmedArgs = args.trim();

    // No args — show help
    if (!trimmedArgs) {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Smart Task Splitting**

Analyze a feature and automatically split it into optimal parallel or sequential tasks.

**Usage:**

\`/split <feature description>\` — Analyze and show suggested split
\`/split execute\` — Execute the suggested split
\`/split show\` — Show current split analysis
\`/split patterns\` — List available split patterns

**Example:**

\`/split User authentication with OAuth\`
\`/split Real-time chat with message history\`
\`/split Analytics dashboard with metrics\`

The splitter will analyze your feature and suggest an optimal task breakdown.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /split patterns — list available patterns
    if (trimmedArgs === 'patterns' || trimmedArgs === 'list') {
      const patternNames = SmartTaskSplitter.getPatternNames();
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Available Split Patterns:**

${patternNames.map((name) => `- \`${name}\``).join('\n')}

Use \`/split <feature description>\` to analyze a feature.`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /split show — show current analysis
    if (trimmedArgs === 'show' || trimmedArgs === 'status') {
      if (!currentAnalysis) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'No active split analysis. Use `/split <feature description>` to analyze a feature first.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatSplitAnalysis(currentAnalysis),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /split execute — execute the current analysis
    if (trimmedArgs === 'execute' || trimmedArgs === 'run') {
      if (!currentAnalysis) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'No active split analysis to execute. Use `/split <feature description>` first.',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      // Show execution start message
      const tasks = currentAnalysis.suggestedSplit;
      const startItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `🚀 **Executing task split:** ${currentAnalysis.featureDescription}

Launching ${tasks.length} tasks in ${currentAnalysis.parallelizable ? 'parallel' : 'sequence'}...

${tasks.map((t) => `${t.icon} **${t.taskName}**`).join('\n')}

Estimated completion: ${currentAnalysis.estimatedTotalTime} minutes`,
      };
      context.ui.addItem(startItem, Date.now());

      // Execute the split
      try {
        const runner = new ParallelTaskRunner(config);
        const splitter = new SmartTaskSplitter();

        const group = await splitter.executeSplit(
          currentAnalysis,
          runner,
          config,
        );

        // Show results
        const summary = ParallelTaskRunner.generateSummary(group);
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: summary,
        };
        context.ui.addItem(historyItem, Date.now());

        // Record the result for learning
        const endTime = group.endTime ?? new Date();
        const startTime = group.startTime ?? new Date();
        const actualMinutes =
          (endTime.getTime() - startTime.getTime()) / 60000;

        splitter.recordSplitResult(
          currentAnalysis.featureDescription,
          currentAnalysis.suggestedSplit,
          actualMinutes,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ **Split execution failed:** ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /split <feature description> — analyze and suggest split
    const description = trimmedArgs;

    // Perform the analysis
    const splitter = new SmartTaskSplitter();
    currentAnalysis = splitter.analyze(description);

    // Show the analysis
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `${formatSplitAnalysis(currentAnalysis)}
---
**Ready to execute.** Use \`/split execute\` to run the tasks.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
