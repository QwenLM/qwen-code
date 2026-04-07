/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import { ModeWorkflowRunner } from '@qwen-code/qwen-code-core';
import type { ModeWorkflow } from '@qwen-code/qwen-code-core';

/**
 * Format a workflow pipeline for display.
 */
function formatPipeline(pipeline: ModeWorkflow): string {
  const iconMap: Record<string, string> = {
    product: '📋',
    architect: '🏗️',
    developer: '💻',
    tester: '🧪',
    reviewer: '🔍',
    debugger: '🐛',
    devops: '🚀',
    security: '🔒',
    optimizer: '⚡',
    general: '🤖',
  };

  const lines = [
    `${pipeline.icon} **${pipeline.name}**`,
    '',
    pipeline.description,
    '',
    `**Steps:** (${pipeline.steps.length})`,
    '',
  ];

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const modeIcon = iconMap[step.mode] ?? '📌';
    lines.push(
      `${i + 1}. ${modeIcon} **${step.mode}** — ${step.prompt.substring(0, 80)}${step.prompt.length > 80 ? '...' : ''}`,
    );

    if (step.maxTimeMinutes) {
      lines.push(`   Time limit: ${step.maxTimeMinutes} min`);
    }
    if (step.qualityGates && step.qualityGates.length > 0) {
      lines.push(`   Quality gates: ${step.qualityGates.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a list of pipelines for display.
 */
function formatPipelineList(
  pipelines: ModeWorkflow[],
  currentPipeline?: string,
): string {
  const lines = ['**Available Workflow Pipelines:**', ''];

  for (const pipeline of pipelines) {
    const prefix = pipeline.name === currentPipeline ? '▸ ' : '  ';
    lines.push(
      `${prefix}${pipeline.icon} **${pipeline.name}**`,
    );
    lines.push(`   ${pipeline.description}`);
    lines.push(`   Steps: ${pipeline.steps.map((s) => s.mode).join(' → ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

export const workflowCommand: SlashCommand = {
  name: 'workflow',
  altNames: ['wf'],
  get description() {
    return t('run mode workflow pipelines (sequential multi-step development)');
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

    // No args — show help and available pipelines
    if (!trimmedArgs) {
      const pipelines = ModeWorkflowRunner.getBuiltinPipelines();
      const content = `**Workflow Pipelines**

Run multi-step development workflows that chain modes sequentially.

${formatPipelineList(pipelines)}

**Usage:**

\`/workflow run <pipeline-name>\` — Run a workflow pipeline
\`/workflow list\` — List all available pipelines
\`/workflow show <pipeline-name>\` — Show pipeline details
\`/workflow cancel\` — Cancel the running workflow
\`/workflow status\` — Show workflow status

**Example:**

\`/workflow run bug-fix\` — Run the bug fix workflow
\`/workflow run full-stack-feature\` — Run the full-stack feature pipeline`;

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /workflow list
    if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
      const pipelines = ModeWorkflowRunner.getBuiltinPipelines();
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatPipelineList(pipelines),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /workflow show <name>
    if (trimmedArgs.startsWith('show') || trimmedArgs.startsWith('info')) {
      const pipelineName = trimmedArgs.replace(/^(show|info)\s*/, '').trim();
      const pipeline = ModeWorkflowRunner.getBuiltinPipeline(pipelineName);

      if (!pipeline) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Pipeline not found: \`${pipelineName}\`\n\nUse \`/workflow list\` to see available pipelines.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatPipeline(pipeline),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /workflow cancel
    if (trimmedArgs === 'cancel') {
      // Note: In a real implementation, we'd need to track the active runner
      // For now, provide guidance
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: 'ℹ️ **Workflow cancellation**\n\nPress `ESC` during workflow execution to cancel the current step, or use `/quit` to stop entirely.\n\nNote: Full workflow cancellation support requires session-level tracking.',
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /workflow status
    if (trimmedArgs === 'status') {
      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: 'ℹ️ **Workflow Status**\n\nNo active workflow running.\n\nUse `/workflow run <pipeline-name>` to start a workflow.',
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /workflow run <name>
    if (trimmedArgs.startsWith('run')) {
      const pipelineName = trimmedArgs.replace(/^run\s*/, '').trim();

      if (!pipelineName) {
        const pipelines = ModeWorkflowRunner.getBuiltinPipelines();
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Usage: \`/workflow run <pipeline-name>\`

**Available pipelines:**

${formatPipelineList(pipelines)}

**Example:**
\`/workflow run bug-fix\``,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const pipeline = ModeWorkflowRunner.getBuiltinPipeline(pipelineName);

      if (!pipeline) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Pipeline not found: \`${pipelineName}\`\n\nUse \`/workflow list\` to see available pipelines.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      // Show pipeline details before starting
      const startContent = `${formatPipeline(pipeline)}
---
**Starting workflow...**

Press \`ESC\` during execution to cancel.

Progress will be shown below.`;

      const startItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: startContent,
      };
      context.ui.addItem(startItem, Date.now());

      // Create and run the workflow
      try {
        const runner = new ModeWorkflowRunner(config);

        // Set up event listeners for progress
        runner.on('step:start', (step: number, mode: string) => {
          const progressItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `⏳ **Step ${step + 1}/${pipeline.steps.length}**: Switching to ${mode} mode...`,
          };
          context.ui.addItem(progressItem, Date.now());
        });

        runner.on('step:complete', (step: number, mode: string) => {
          const modeIcon = getModeIcon(mode);
          const progressItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `✅ **Step ${step + 1}/${pipeline.steps.length}**: ${modeIcon} ${mode} mode complete`,
          };
          context.ui.addItem(progressItem, Date.now());
        });

        runner.on('progress', (text: string) => {
          const progressItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `💬 ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`,
          };
          context.ui.addItem(progressItem, Date.now());
        });

        // Run the pipeline
        const result = await runner.runPipeline(pipeline, config);

        if (result.success) {
          const completeItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `🎉 **Workflow Complete:** ${pipeline.icon} ${pipeline.name}\n\n✅ All ${result.completedSteps} steps completed successfully.`,
          };
          context.ui.addItem(completeItem, Date.now());
        } else {
          const failItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `❌ **Workflow Failed:** ${pipeline.icon} ${pipeline.name}\n\n**Completed:** ${result.completedSteps}/${pipeline.steps.length} steps\n**Failed at step:** ${result.failedStep !== undefined ? result.failedStep + 1 : 'N/A'}\n**Error:** ${result.error ?? 'Unknown error'}`,
          };
          context.ui.addItem(failItem, Date.now());
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ **Workflow error:** ${errorMessage}`,
        };
        context.ui.addItem(errorItem, Date.now());
      }

      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown command: \`/workflow ${trimmedArgs}\`

Available subcommands:
- \`run <pipeline-name>\` — Run a workflow pipeline
- \`list\` — List all available pipelines
- \`show <pipeline-name>\` — Show pipeline details
- \`cancel\` — Cancel the running workflow
- \`status\` — Show workflow status

Use \`/workflow\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};

/**
 * Get the icon for a mode name.
 */
function getModeIcon(modeName: string): string {
  const iconMap: Record<string, string> = {
    product: '📋',
    architect: '🏗️',
    developer: '💻',
    tester: '🧪',
    reviewer: '🔍',
    debugger: '🐛',
    devops: '🚀',
    security: '🔒',
    optimizer: '⚡',
    general: '🤖',
  };
  return iconMap[modeName] ?? '📌';
}
