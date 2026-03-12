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
  isTerminalStatus,
  isSuccessStatus,
  ArenaSessionStatus,
  AuthType,
  createDebugLogger,
  stripStartupContext,
  type Config,
  type ArenaModelConfig,
  type ArenaAgentErrorEvent,
  type ArenaAgentCompleteEvent,
  type ArenaAgentStartEvent,
  type ArenaSessionCompleteEvent,
  type ArenaSessionErrorEvent,
  type ArenaSessionStartEvent,
  type ArenaSessionUpdateEvent,
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

  // Build ArenaModelConfig for each model, resolving display names from
  // the model registry when available.
  const modelsConfig = config.getModelsConfig();
  const models: ArenaModelConfig[] = parsed.models.map((parsedModel) => {
    const authType =
      (parsedModel.authType as AuthType | undefined) ?? defaultAuthType;
    const registryModels = modelsConfig.getAvailableModelsForAuthType(authType);
    const resolved = registryModels.find((m) => m.id === parsedModel.modelId);
    return {
      modelId: parsedModel.modelId,
      authType,
      displayName: resolved?.label ?? parsedModel.modelId,
    };
  });

  return {
    task: parsed.task,
    models,
    approvalMode: config.getApprovalMode(),
  };
}

/**
 * Persists a single arena history item to the session JSONL file.
 *
 * Arena events fire asynchronously (after the slash command's recording
 * window has closed), so each item must be recorded individually.
 */
function recordArenaItem(config: Config, item: HistoryItemWithoutId): void {
  try {
    const chatRecorder = config.getChatRecordingService();
    if (!chatRecorder) return;
    chatRecorder.recordSlashCommand({
      phase: 'result',
      rawCommand: '/arena',
      outputHistoryItems: [{ ...item } as Record<string, unknown>],
    });
  } catch {
    debugLogger.error('Failed to record arena history item');
  }
}

function executeArenaCommand(
  config: Config,
  ui: CommandContext['ui'],
  input: ArenaExecutionInput,
): void {
  // Capture the main session's chat history so arena agents start with
  // conversational context. Strip the leading startup context (env info
  // user message + model ack) because each agent generates its own for
  // its worktree directory — keeping the parent's would duplicate it.
  let chatHistory;
  try {
    const fullHistory = config.getGeminiClient().getHistory();
    chatHistory = stripStartupContext(fullHistory);
  } catch {
    debugLogger.debug('Could not retrieve chat history for arena agents');
  }

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

  const addAndRecordArenaMessage = (
    type: 'info' | 'warning' | 'error' | 'success',
    text: string,
  ) => {
    const item: HistoryItemWithoutId = { type, text };
    ui.addItem(item, Date.now());
    recordArenaItem(config, item);
  };

  const handleSessionStart = (event: ArenaSessionStartEvent) => {
    const modelList = event.models
      .map((model, index) => `  ${index + 1}. ${model.modelId}`)
      .join('\n');
    // SESSION_START fires synchronously before the first await in
    // ArenaManager.start(), so the slash command processor's finally
    // block already captures this item — no extra recording needed.
    addArenaMessage(
      MessageType.INFO,
      `Arena started with ${event.models.length} agents on task: "${event.task}"\nModels:\n${modelList}`,
    );
  };

  const handleAgentStart = (event: ArenaAgentStartEvent) => {
    agentLabels.set(event.agentId, event.model.modelId);
    debugLogger.debug(
      `Arena agent started: ${event.model.modelId} (${event.agentId})`,
    );
  };

  const handleSessionUpdate = (event: ArenaSessionUpdateEvent) => {
    const attachHintPrefix = 'To view agent panes, run: ';
    if (event.message.startsWith(attachHintPrefix)) {
      const command = event.message.slice(attachHintPrefix.length).trim();
      addAndRecordArenaMessage(
        MessageType.INFO,
        `Arena panes are running in tmux. Attach with: \`${command}\``,
      );
      return;
    }

    if (event.type === 'success') {
      addAndRecordArenaMessage(MessageType.SUCCESS, event.message);
    } else if (event.type === 'info') {
      addAndRecordArenaMessage(MessageType.INFO, event.message);
    } else {
      addAndRecordArenaMessage(MessageType.WARNING, event.message);
    }
  };

  const handleAgentError = (event: ArenaAgentErrorEvent) => {
    const label = agentLabels.get(event.agentId) || event.agentId;
    addAndRecordArenaMessage(
      MessageType.ERROR,
      `[${label}] failed: ${event.error}`,
    );
  };

  const buildAgentCardData = (
    result: ArenaAgentCompleteEvent['result'],
  ): ArenaAgentCardData => ({
    label: result.model.modelId,
    status: result.status,
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
  });

  const handleAgentComplete = (event: ArenaAgentCompleteEvent) => {
    if (!isTerminalStatus(event.result.status)) {
      return;
    }

    const agent = buildAgentCardData(event.result);
    const item = {
      type: 'arena_agent_complete',
      agent,
    } as HistoryItemWithoutId;
    ui.addItem(item, Date.now());
    recordArenaItem(config, item);
  };

  const handleSessionError = (event: ArenaSessionErrorEvent) => {
    addAndRecordArenaMessage(MessageType.ERROR, `${event.error}`);
  };

  const handleSessionComplete = (event: ArenaSessionCompleteEvent) => {
    const item = {
      type: 'arena_session_complete',
      sessionStatus: event.result.status,
      task: event.result.task,
      totalDurationMs: event.result.totalDurationMs ?? 0,
      agents: event.result.agents.map(buildAgentCardData),
    } as HistoryItemWithoutId;
    ui.addItem(item, Date.now());
    recordArenaItem(config, item);
  };

  emitter.on(ArenaEventType.SESSION_START, handleSessionStart);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.SESSION_START, handleSessionStart),
  );
  emitter.on(ArenaEventType.AGENT_START, handleAgentStart);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.AGENT_START, handleAgentStart),
  );
  emitter.on(ArenaEventType.SESSION_UPDATE, handleSessionUpdate);
  detachListeners.push(() =>
    emitter.off(ArenaEventType.SESSION_UPDATE, handleSessionUpdate),
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
      chatHistory,
    })
    .then(
      () => {
        debugLogger.debug('Arena agents settled');
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        addAndRecordArenaMessage(MessageType.ERROR, `${message}`);
        debugLogger.error('Arena session failed:', error);

        // Clear the stored manager so subsequent /arena start calls
        // are not blocked by the stale reference after a startup failure.
        config.setArenaManager(null);

        // Detach listeners on failure — session is done for good.
        for (const detach of detachListeners) {
          detach();
        }
      },
    );

  // NOTE: listeners are NOT detached when start() resolves because agents
  // may still be alive (IDLE) and accept follow-up tasks. The listeners
  // reference this manager's emitter, so they are garbage collected when
  // the manager is cleaned up and replaced.

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
        const hasSuccessful = agents.some((a) => isSuccessStatus(a.status));

        if (!hasSuccessful) {
          return {
            type: 'message',
            messageType: 'error',
            content:
              'No successful agent results to select from. All agents failed or were cancelled.\n' +
              'Use /arena stop to end the session.',
          };
        }

        // Handle direct model selection via args
        if (trimmedArgs) {
          const matchingAgent = agents.find(
            (a) =>
              isSuccessStatus(a.status) &&
              a.model.modelId.toLowerCase() === trimmedArgs.toLowerCase(),
          );

          if (!matchingAgent) {
            return {
              type: 'message',
              messageType: 'error',
              content: `No idle agent found matching "${trimmedArgs}".`,
            };
          }

          const label = matchingAgent.model.modelId;
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
