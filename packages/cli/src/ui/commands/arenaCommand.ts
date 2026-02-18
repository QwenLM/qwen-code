/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  ConfirmActionReturn,
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  ArenaManager,
  ArenaEventType,
  ArenaAgentStatus,
  ArenaSessionStatus,
  AuthType,
  createDebugLogger,
  type Config,
  type ArenaModelConfig,
  type ArenaAgentErrorEvent,
  type ArenaAgentCompleteEvent,
  type ArenaAgentStartEvent,
  type ArenaSessionCompleteEvent,
  type ArenaSessionErrorEvent,
  type ArenaSessionStartEvent,
  type ArenaSessionWarningEvent,
} from '@qwen-code/qwen-code-core';
import {
  MessageType,
  type ArenaAgentCardData,
  type HistoryItemWithoutId,
} from '../types.js';

/**
 * Parsed model entry with optional auth type.
 */
interface ParsedModel {
  authType?: string;
  modelId: string;
}

/**
 * Parses arena command arguments.
 *
 * Supported formats:
 *   /arena start --models model1,model2 <task>
 *   /arena start --models authType1:model1,authType2:model2 <task>
 *
 * Model format: [authType:]modelId
 *   - "gpt-4o" → uses default auth type
 *   - "openai:gpt-4o" → uses "openai" auth type
 */
function parseArenaArgs(args: string): {
  models: ParsedModel[];
  task: string;
} {
  const modelsMatch = args.match(/--models\s+(\S+)/);

  let models: ParsedModel[] = [];
  let task = args;

  if (modelsMatch) {
    const modelStrings = modelsMatch[1]!.split(',').filter(Boolean);
    models = modelStrings.map((str) => {
      // Check for authType:modelId format
      const colonIndex = str.indexOf(':');
      if (colonIndex > 0) {
        return {
          authType: str.substring(0, colonIndex),
          modelId: str.substring(colonIndex + 1),
        };
      }
      return { modelId: str };
    });
    task = task.replace(/--models\s+\S+/, '').trim();
  }

  // Strip surrounding quotes from task
  task = task.replace(/^["']|["']$/g, '').trim();

  return { models, task };
}

const debugLogger = createDebugLogger('ARENA_COMMAND');

interface ArenaExecutionInput {
  task: string;
  models: ArenaModelConfig[];
  approvalMode?: string;
}

function buildArenaExecutionInput(
  parsed: ReturnType<typeof parseArenaArgs>,
  config: Config,
): ArenaExecutionInput | MessageActionReturn {
  if (!parsed.task) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Usage: /arena start --models model1,model2 <task>\n' +
        '\n' +
        'Options:\n' +
        '  --models [authType:]model1,[authType:]model2\n' +
        '                            Models to compete (required, at least 2)\n' +
        '                            Format: authType:modelId or just modelId\n' +
        '\n' +
        'Examples:\n' +
        '  /arena start --models openai:gpt-4o,anthropic:claude-3 "implement sorting"\n' +
        '  /arena start --models qwen-coder-plus,kimi-for-coding "fix the bug"',
    };
  }

  if (parsed.models.length < 2) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Arena requires at least 2 models. Use --models model1,model2 to specify.\n' +
        'Format: [authType:]modelId (e.g., openai:gpt-4o or just gpt-4o)',
    };
  }

  // Get the current auth type as default for models without explicit auth type
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const defaultAuthType =
    contentGeneratorConfig?.authType ?? AuthType.USE_OPENAI;

  // Build ArenaModelConfig for each model
  const models: ArenaModelConfig[] = parsed.models.map((parsedModel) => ({
    modelId: parsedModel.modelId,
    authType: parsedModel.authType ?? defaultAuthType,
    displayName: parsedModel.authType
      ? `${parsedModel.authType}:${parsedModel.modelId}`
      : parsedModel.modelId,
  }));

  return {
    task: parsed.task,
    models,
    approvalMode: config.getApprovalMode(),
  };
}

function executeArenaCommand(
  config: Config,
  ui: CommandContext['ui'],
  input: ArenaExecutionInput,
): void {
  const manager = new ArenaManager(config);
  const emitter = manager.getEventEmitter();
  const detachListeners: Array<() => void> = [];
  const agentLabels = new Map<string, string>();

  const addArenaMessage = (
    type: 'info' | 'warning' | 'error' | 'success',
    text: string,
  ) => {
    ui.addItem({ type, text }, Date.now());
  };

  const handleSessionStart = (event: ArenaSessionStartEvent) => {
    const modelList = event.models
      .map(
        (model, index) =>
          `  ${index + 1}. ${model.displayName || model.modelId}`,
      )
      .join('\n');
    addArenaMessage(
      MessageType.INFO,
      `Arena started with ${event.models.length} agents on task: "${event.task}"\nModels:\n${modelList}`,
    );
  };

  const handleAgentStart = (event: ArenaAgentStartEvent) => {
    const label = event.model.displayName || event.model.modelId;
    agentLabels.set(event.agentId, label);
    debugLogger.debug(`Arena agent started: ${label} (${event.agentId})`);
  };

  const handleSessionWarning = (event: ArenaSessionWarningEvent) => {
    const attachHintPrefix = 'To view agent panes, run: ';
    if (event.message.startsWith(attachHintPrefix)) {
      const command = event.message.slice(attachHintPrefix.length).trim();
      addArenaMessage(
        MessageType.INFO,
        `Arena panes are running in tmux. Attach with: \`${command}\``,
      );
      return;
    }
    addArenaMessage(MessageType.WARNING, `Arena warning: ${event.message}`);
  };

  const handleAgentError = (event: ArenaAgentErrorEvent) => {
    const label = agentLabels.get(event.agentId) || event.agentId;
    addArenaMessage(MessageType.ERROR, `[${label}] failed: ${event.error}`);
  };

  const buildAgentCardData = (
    result: ArenaAgentCompleteEvent['result'],
  ): ArenaAgentCardData => {
    let status: ArenaAgentCardData['status'];
    switch (result.status) {
      case ArenaAgentStatus.COMPLETED:
        status = 'completed';
        break;
      case ArenaAgentStatus.CANCELLED:
        status = 'cancelled';
        break;
      default:
        status = 'terminated';
        break;
    }
    return {
      label: result.model.displayName || result.model.modelId,
      status,
      durationMs: result.stats.durationMs,
      totalTokens: result.stats.totalTokens,
      inputTokens: result.stats.inputTokens,
      outputTokens: result.stats.outputTokens,
      toolCalls: result.stats.toolCalls,
      successfulToolCalls: result.stats.successfulToolCalls,
      failedToolCalls: result.stats.failedToolCalls,
      rounds: result.stats.rounds,
      error: result.error,
      diff: result.diff,
    };
  };

  const handleAgentComplete = (event: ArenaAgentCompleteEvent) => {
    // Show message for completed (success), cancelled, and terminated (error) agents
    if (
      event.result.status !== ArenaAgentStatus.COMPLETED &&
      event.result.status !== ArenaAgentStatus.CANCELLED &&
      event.result.status !== ArenaAgentStatus.TERMINATED
    ) {
      return;
    }

    const agent = buildAgentCardData(event.result);
    ui.addItem(
      {
        type: 'arena_agent_complete',
        agent,
      } as HistoryItemWithoutId,
      Date.now(),
    );
  };

  const handleSessionError = (event: ArenaSessionErrorEvent) => {
    addArenaMessage(MessageType.ERROR, `Arena failed: ${event.error}`);
  };

  const handleSessionComplete = (event: ArenaSessionCompleteEvent) => {
    ui.addItem(
      {
        type: 'arena_session_complete',
        sessionStatus: event.result.status,
        task: event.result.task,
        totalDurationMs: event.result.totalDurationMs ?? 0,
        agents: event.result.agents.map(buildAgentCardData),
      } as HistoryItemWithoutId,
      Date.now(),
    );
  };

  emitter.on(ArenaEventType.SESSION_START, handleSessionStart);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.SESSION_START, handleSessionStart),
  );
  emitter.on(ArenaEventType.AGENT_START, handleAgentStart);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.AGENT_START, handleAgentStart),
  );
  emitter.on(ArenaEventType.SESSION_WARNING, handleSessionWarning);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.SESSION_WARNING, handleSessionWarning),
  );
  emitter.on(ArenaEventType.AGENT_ERROR, handleAgentError);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.AGENT_ERROR, handleAgentError),
  );
  emitter.on(ArenaEventType.AGENT_COMPLETE, handleAgentComplete);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.AGENT_COMPLETE, handleAgentComplete),
  );
  emitter.on(ArenaEventType.SESSION_ERROR, handleSessionError);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.SESSION_ERROR, handleSessionError),
  );
  emitter.on(ArenaEventType.SESSION_COMPLETE, handleSessionComplete);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.SESSION_COMPLETE, handleSessionComplete),
  );

  config.setArenaManager(manager);

  const cols = process.stdout.columns || 120;
  const rows = Math.max((process.stdout.rows || 40) - 2, 1);

  const lifecycle = manager
    .start({
      task: input.task,
      models: input.models,
      cols,
      rows,
      approvalMode: input.approvalMode,
    })
    .then(
      () => {
        debugLogger.debug('Arena session completed');
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        addArenaMessage(MessageType.ERROR, `Arena failed: ${message}`);
        debugLogger.error('Arena session failed:', error);

        // Clear the stored manager so subsequent /arena start calls
        // are not blocked by the stale reference after a startup failure.
        config.setArenaManager(null);
      },
    )
    .finally(() => {
      for (const detach of detachListeners) {
        detach();
      }
    });

  // Store so that stop can wait for start() to fully unwind before cleanup
  manager.setLifecyclePromise(lifecycle);
}

export const arenaCommand: SlashCommand = {
  name: 'arena',
  description: 'Manage Arena sessions',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'start',
      description:
        'Start an Arena session with multiple models competing on the same task',
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<void | MessageActionReturn | OpenDialogActionReturn> => {
        const executionMode = context.executionMode ?? 'interactive';
        if (executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.',
          };
        }

        const { services, ui } = context;
        const { config } = services;

        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Configuration not available.',
          };
        }

        // Refuse to start if a session already exists (regardless of status)
        const existingManager = config.getArenaManager();
        if (existingManager) {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.',
          };
        }

        const parsed = parseArenaArgs(args);
        if (parsed.models.length === 0) {
          return {
            type: 'dialog',
            dialog: 'arena_start',
          };
        }

        const executionInput = buildArenaExecutionInput(parsed, config);
        if ('type' in executionInput) {
          return executionInput;
        }

        executeArenaCommand(config, ui, executionInput);
      },
    },
    {
      name: 'stop',
      description: 'Stop the current Arena session',
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
      ): Promise<void | SlashCommandActionReturn> => {
        const executionMode = context.executionMode ?? 'interactive';
        if (executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.',
          };
        }

        const { config } = context.services;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Configuration not available.',
          };
        }

        const manager = config.getArenaManager();
        if (!manager) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'No running Arena session found.',
          };
        }

        return {
          type: 'dialog',
          dialog: 'arena_stop',
        };
      },
    },
    {
      name: 'status',
      description: 'Show the current Arena session status',
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
      ): Promise<void | SlashCommandActionReturn> => {
        const executionMode = context.executionMode ?? 'interactive';
        if (executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Arena is not supported in non-interactive mode.',
          };
        }

        const { config } = context.services;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Configuration not available.',
          };
        }

        const manager = config.getArenaManager();
        if (!manager) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'No Arena session found. Start one with /arena start.',
          };
        }

        return {
          type: 'dialog',
          dialog: 'arena_status',
        };
      },
    },
    {
      name: 'select',
      altNames: ['choose'],
      description:
        'Select a model result and merge its diff into the current workspace',
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<
        | void
        | MessageActionReturn
        | OpenDialogActionReturn
        | ConfirmActionReturn
      > => {
        const executionMode = context.executionMode ?? 'interactive';
        if (executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Arena is not supported in non-interactive mode.',
          };
        }

        const { config } = context.services;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Configuration not available.',
          };
        }

        const manager = config.getArenaManager();

        if (!manager) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'No arena session found. Start one with /arena start.',
          };
        }

        const sessionStatus = manager.getSessionStatus();
        if (
          sessionStatus === ArenaSessionStatus.RUNNING ||
          sessionStatus === ArenaSessionStatus.INITIALIZING
        ) {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'Arena session is still running. Wait for it to complete or use /arena stop first.',
          };
        }

        // Handle --discard flag before checking for successful agents,
        // so users can clean up worktrees even when all agents failed.
        const trimmedArgs = args.trim();
        if (trimmedArgs === '--discard') {
          if (!context.overwriteConfirmed) {
            return {
              type: 'confirm_action',
              prompt: 'Discard all Arena results and clean up worktrees?',
              originalInvocation: {
                raw: context.invocation?.raw || '/arena select --discard',
              },
            };
          }

          await config.cleanupArenaRuntime(true);
          return {
            type: 'message',
            messageType: 'info',
            content: 'Arena results discarded. All worktrees cleaned up.',
          };
        }

        const agents = manager.getAgentStates();
        const hasSuccessful = agents.some(
          (a) => a.status === ArenaAgentStatus.COMPLETED,
        );

        if (!hasSuccessful) {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'No successful agent results to select from. All agents failed or were cancelled.\n' +
              'Use /arena select --discard to clean up worktrees, or /arena stop to end the session.',
          };
        }

        // Handle direct model selection via args
        if (trimmedArgs) {
          const matchingAgent = agents.find((a) => {
            const label = a.model.displayName || a.model.modelId;
            return (
              a.status === ArenaAgentStatus.COMPLETED &&
              (label.toLowerCase() === trimmedArgs.toLowerCase() ||
                a.model.modelId.toLowerCase() === trimmedArgs.toLowerCase())
            );
          });

          if (!matchingAgent) {
            return {
              type: 'message',
              messageType: 'error',
              content: `No idle agent found matching "${trimmedArgs}".`,
            };
          }

          const label =
            matchingAgent.model.displayName || matchingAgent.model.modelId;
          const result = await manager.applyAgentResult(matchingAgent.agentId);
          if (!result.success) {
            return {
              type: 'message',
              messageType: 'error',
              content: `Failed to apply changes from ${label}: ${result.error}`,
            };
          }

          await config.cleanupArenaRuntime(true);
          return {
            type: 'message',
            messageType: 'info',
            content: `Applied changes from ${label} to workspace. Arena session complete.`,
          };
        }

        // No args → open the select dialog
        return {
          type: 'dialog',
          dialog: 'arena_select',
        };
      },
    },
  ],
};
