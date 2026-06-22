/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useMemo,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { type PartListUnion } from '@google/genai';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { ArenaDialogType } from './useArenaCommand.js';
import {
  type Logger,
  type Config,
  createDebugLogger,
  logSlashCommand,
  makeSlashCommandEvent,
  SlashCommandStatus,
  ToolConfirmationOutcome,
  IdeClient,
  type SessionListItem,
  addMCPStatusChangeListener,
  removeMCPStatusChangeListener,
  MCPServerStatus,
} from '@qwen-code/qwen-code-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import type {
  Message,
  HistoryItemWithoutId,
  HistoryItemBtw,
  SlashCommandProcessorResult,
  HistoryItem,
  ConfirmationRequest,
} from '../types.js';
import { MessageType } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { type CommandContext, type SlashCommand } from '../commands/types.js';
import type { RecentSlashCommand } from './useSlashCompletion.js';
import { CommandService } from '../../services/CommandService.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { BundledSkillLoader } from '../../services/BundledSkillLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { SavedWorkflowLoader } from '../../services/saved-workflow-loader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { SkillCommandLoader } from '../../services/SkillCommandLoader.js';
import { parseSlashCommand } from '../../utils/commands.js';
import {
  hasSlashCommandPathSeparator,
  isBtwCommand,
} from '../utils/commandUtils.js';
import { clearScreen } from '../../utils/stdioHelpers.js';
import { useKeypress } from './useKeypress.js';
import {
  type ExtensionUpdateAction,
  type ExtensionUpdateStatus,
} from '../state/extensions.js';
import {
  appendUserPromptExpansionAdditionalContext,
  formatUserPromptExpansionBlockedMessage,
  serializeUserPromptExpansionPrompt,
} from '../../utils/userPromptExpansionHook.js';

type SerializableHistoryItem = Record<string, unknown>;
const debugLogger = createDebugLogger('SLASH_COMMAND_PROCESSOR');

function hasUserPromptExpansionHooks(config: Config | null): config is Config {
  return (
    !!config &&
    !config.getDisableAllHooks?.() &&
    (config.hasHooksForEvent?.('UserPromptExpansion') ?? false)
  );
}

function serializeHistoryItemForRecording(
  item: HistoryItemWithoutId,
): SerializableHistoryItem {
  const clone: SerializableHistoryItem = { ...item };
  if ('timestamp' in clone && clone['timestamp'] instanceof Date) {
    clone['timestamp'] = clone['timestamp'].toISOString();
  }
  return clone;
}

const SLASH_COMMANDS_SKIP_RECORDING = new Set([
  'quit',
  'exit',
  'clear',
  'reset',
  'new',
  'resume',
  'delete',
  'branch',
  'btw',
  'history',
]);

export interface SlashCommandProcessorActions {
  openAuthDialog: () => void;
  openArenaDialog?: (type: Exclude<ArenaDialogType, null>) => void;
  openThemeDialog: () => void;
  openEditorDialog: () => void;
  openMemoryDialog: () => void;
  openSettingsDialog: () => void;
  openStatusLineDialog: () => void;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    voiceModelMode?: boolean;
  }) => void;
  openTrustDialog: () => void;
  openPermissionsDialog: () => void;
  openApprovalModeDialog: () => void;
  openResumeDialog: (matchedSessions?: SessionListItem[]) => void;
  handleResume: (sessionId: string) => Promise<void>;
  handleBranch: (name?: string) => Promise<void>;
  openDeleteDialog: () => void;
  quit: (messages: HistoryItem[]) => void;
  setDebugMessage: (message: string) => void;
  dispatchExtensionStateUpdate: (action: ExtensionUpdateAction) => void;
  addConfirmUpdateExtensionRequest: (request: ConfirmationRequest) => void;
  openSubagentCreateDialog: () => void;
  openAgentsManagerDialog: () => void;
  openSkillsManagerDialog: () => void;
  openExtensionsManagerDialog: () => void;
  openMcpDialog: () => void;
  openHooksDialog: () => void;
  openStatsDialog: () => void;
  openRewindSelector: () => void;
  openDiffDialog: () => void;
  openHelpDialog: () => void;
}

/**
 * Hook to define and process slash commands (e.g., /help, /clear).
 */
export const useSlashCommandProcessor = (
  config: Config | null,
  settings: LoadedSettings,
  history: HistoryItem[],
  addItem: UseHistoryManagerReturn['addItem'],
  clearItems: UseHistoryManagerReturn['clearItems'],
  loadHistory: UseHistoryManagerReturn['loadHistory'],
  refreshStatic: () => void,
  toggleVimEnabled: () => Promise<boolean>,
  isProcessing: boolean,
  setIsProcessing: (isProcessing: boolean) => void,
  isIdleRef: MutableRefObject<boolean>,
  setGeminiMdFileCount: (count: number) => void,
  actions: SlashCommandProcessorActions,
  extensionsUpdateState: Map<string, ExtensionUpdateStatus>,
  isConfigInitialized: boolean,
  logger: Logger | null,
  updateItem: UseHistoryManagerReturn['updateItem'],
  setSessionName?: (name: string | null) => void,
) => {
  // Ref avoids adding `history` to the commandContext useMemo deps,
  // which would cause a full context rebuild on every history append.
  const historyRef = useRef(history);
  useLayoutEffect(() => {
    historyRef.current = history;
  }, [history]);

  const { stats: sessionStats, startNewSession } = useSessionStats();
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [recentCommands, setRecentCommands] = useState<
    ReadonlyMap<string, RecentSlashCommand>
  >(new Map());
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const commandReloadResolversRef = useRef<
    Array<{ trigger: number; resolve: () => void }>
  >([]);

  const resolveCommandReloads = useCallback((completedTrigger: number) => {
    if (commandReloadResolversRef.current.length === 0) {
      return;
    }

    const remaining: Array<{ trigger: number; resolve: () => void }> = [];
    for (const request of commandReloadResolversRef.current) {
      if (request.trigger <= completedTrigger) {
        request.resolve();
      } else {
        remaining.push(request);
      }
    }
    commandReloadResolversRef.current = remaining;
  }, []);

  const reloadCommands = useCallback((): Promise<void> => {
    if (!config) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      setReloadTrigger((v) => {
        const nextTrigger = v + 1;
        commandReloadResolversRef.current.push({
          trigger: nextTrigger,
          resolve,
        });
        return nextTrigger;
      });
    });
  }, [config]);
  const [shellConfirmationRequest, setShellConfirmationRequest] =
    useState<null | {
      commands: string[];
      onConfirm: (
        outcome: ToolConfirmationOutcome,
        approvedCommands?: string[],
      ) => void;
    }>(null);
  const [confirmationRequest, setConfirmationRequest] = useState<null | {
    prompt: React.ReactNode;
    onConfirm: (confirmed: boolean) => void;
  }>(null);

  const [sessionShellAllowlist, setSessionShellAllowlist] = useState(
    new Set<string>(),
  );
  const [pendingItem, setPendingItem] = useState<HistoryItemWithoutId | null>(
    null,
  );

  const [btwItem, setBtwItem] = useState<HistoryItemBtw | null>(null);
  const btwAbortControllerRef = useRef<AbortController | null>(null);

  const cancelBtw = useCallback(() => {
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setBtwItem(null);
  }, []);

  // AbortController for cancelling async slash commands via ESC
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelSlashCommand = useCallback(() => {
    cancelBtw();
    if (!abortControllerRef.current) {
      return;
    }
    abortControllerRef.current.abort();
    addItem(
      {
        type: MessageType.INFO,
        text: 'Command cancelled.',
      },
      Date.now(),
    );
    setPendingItem(null);
    setIsProcessing(false);
  }, [addItem, setIsProcessing, cancelBtw]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        cancelSlashCommand();
      }
    },
    { isActive: isProcessing },
  );

  const pendingHistoryItems = useMemo(() => {
    const items: HistoryItemWithoutId[] = [];
    if (pendingItem != null) {
      items.push(pendingItem);
    }
    return items;
  }, [pendingItem]);

  const addMessage = useCallback(
    (message: Message) => {
      // Convert Message to HistoryItemWithoutId
      let historyItemContent: HistoryItemWithoutId;
      if (message.type === MessageType.ABOUT) {
        historyItemContent = {
          type: 'about',
          systemInfo: message.systemInfo,
        };
      } else if (message.type === MessageType.HELP) {
        historyItemContent = {
          type: 'help',
          timestamp: message.timestamp,
        };
      } else if (message.type === MessageType.STATS) {
        historyItemContent = {
          type: 'stats',
          duration: message.duration,
        };
      } else if (message.type === MessageType.MODEL_STATS) {
        historyItemContent = {
          type: 'model_stats',
        };
      } else if (message.type === MessageType.TOOL_STATS) {
        historyItemContent = {
          type: 'tool_stats',
        };
      } else if (message.type === MessageType.QUIT) {
        historyItemContent = {
          type: 'quit',
          duration: message.duration,
        };
      } else if (message.type === MessageType.COMPRESSION) {
        historyItemContent = {
          type: 'compression',
          compression: message.compression,
        };
      } else if (message.type === MessageType.SUMMARY) {
        historyItemContent = {
          type: 'summary',
          summary: message.summary,
        };
      } else if (message.type === MessageType.INSIGHT_PROGRESS) {
        historyItemContent = {
          type: 'insight_progress',
          progress: message.progress,
        };
      } else {
        historyItemContent = {
          type: message.type,
          text: message.content,
        };
      }
      addItem(historyItemContent, message.timestamp.getTime());
    },
    [addItem],
  );
  const commandContext = useMemo(
    (): CommandContext => ({
      services: {
        config,
        settings,
        logger,
      },
      ui: {
        get history() {
          return historyRef.current;
        },
        addItem,
        clear: () => {
          cancelBtw();
          clearItems();
          clearScreen();
          refreshStatic();
          setSessionName?.(null);
        },
        loadHistory,
        refreshStatic,
        setDebugMessage: actions.setDebugMessage,
        pendingItem,
        setPendingItem,
        btwItem,
        setBtwItem,
        cancelBtw,
        btwAbortControllerRef,
        isIdleRef,
        toggleVimEnabled,
        setGeminiMdFileCount,
        reloadCommands,
        setSessionName: setSessionName ?? (() => {}),
        extensionsUpdateState,
        dispatchExtensionStateUpdate: actions.dispatchExtensionStateUpdate,
        addConfirmUpdateExtensionRequest:
          actions.addConfirmUpdateExtensionRequest,
      },
      session: {
        stats: sessionStats,
        sessionShellAllowlist,
        startNewSession,
      },
      executionMode: 'interactive' as const,
    }),
    [
      config,
      settings,
      logger,
      loadHistory,
      addItem,
      clearItems,
      refreshStatic,
      sessionStats,
      startNewSession,
      actions,
      pendingItem,
      setPendingItem,
      btwItem,
      setBtwItem,
      cancelBtw,
      toggleVimEnabled,
      sessionShellAllowlist,
      setGeminiMdFileCount,
      reloadCommands,
      setSessionName,
      extensionsUpdateState,
      isIdleRef,
    ],
  );

  useEffect(() => {
    if (!config) {
      return;
    }

    const listener = () => {
      reloadCommands();
    };

    (async () => {
      const ideClient = await IdeClient.getInstance();
      ideClient.addStatusChangeListener(listener);
    })();

    return () => {
      (async () => {
        const ideClient = await IdeClient.getInstance();
        ideClient.removeStatusChangeListener(listener);
      })();
    };
  }, [config, reloadCommands]);

  // MCP discovery is progressive: it runs in the background after the UI is
  // already interactive, so a server's prompts (prompts/list) are not in the
  // registry when the command loaders first run. Without this, an MCP prompt
  // never surfaces as a `/<prompt>` command until some unrelated reload (IDE
  // status / skill change) happens to fire — the `/mcp` dialog shows the
  // prompt count while the slash menu stays empty. Rebuild the command tree
  // when a server finishes connecting; debounce so a burst of servers
  // connecting at startup triggers a single rebuild.
  useEffect(() => {
    if (!config) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listener = (
      _serverName: string,
      status: MCPServerStatus | undefined,
    ) => {
      if (status !== MCPServerStatus.CONNECTED) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        reloadCommands();
      }, 250);
    };
    addMCPStatusChangeListener(listener);
    return () => {
      removeMCPStatusChangeListener(listener);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [config, reloadCommands]);

  // SkillManager rebuilds its own cache when skills change on disk. The
  // slash-command list is a separate consumer: SkillCommandLoader reads
  // `listSkills()` once during CommandService.create(), so without this
  // bridge a newly added SKILL.md never produces a `/<skill-name>` entry
  // until restart. Bumping reloadTrigger re-runs the loader effect below
  // and CommandService picks up the fresh skill list.
  useEffect(() => {
    if (!isConfigInitialized) {
      return;
    }
    const skillManager = config?.getSkillManager();
    if (!skillManager) {
      return;
    }
    return skillManager.addChangeListener(() => {
      // The `/skills` dialog calls `reloadCommands()` itself BEFORE it
      // calls `notifyConfigChanged()`, so a listener-driven second reload
      // would be a wasted CommandService rebuild on every save. Honor the
      // one-shot suppression signal — disk-driven changes (no
      // dialog-orchestrated reload) leave the flag false and reload
      // normally.
      if (skillManager.consumeSlashReloadSuppression()) {
        return;
      }
      reloadCommands();
    });
  }, [config, isConfigInitialized, reloadCommands]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const loaders = [
          new McpPromptLoader(config),
          new BuiltinCommandLoader(config),
          new BundledSkillLoader(config),
          new SkillCommandLoader(config),
          new SavedWorkflowLoader(config),
          new FileCommandLoader(config),
        ];
        const disabled = config?.getDisabledSlashCommands() ?? [];
        const commandService = await CommandService.create(
          loaders,
          controller.signal,
          disabled.length > 0 ? new Set(disabled) : undefined,
        );
        // Avoid overwriting newer results from a subsequent effect run
        if (controller.signal.aborted) {
          return;
        }
        // Register model-invocable commands provider so the startup snapshot
        // and per-turn drain include bundled skills, file commands, and MCP
        // prompts in the <available_skills> listing.
        if (config) {
          config.setModelInvocableCommandsProvider(() =>
            commandService.getModelInvocableCommands().map((cmd) => ({
              name: cmd.name,
              description: cmd.modelDescription ?? cmd.description,
            })),
          );
          // Register executor so SkillTool can actually invoke model-invocable
          // commands (e.g. MCP prompts) that are not file-based skills.
          config.setModelInvocableCommandsExecutor(
            async (name: string, args: string = '') => {
              const commands = commandService.getModelInvocableCommands();
              const cmd = commands.find((c) => c.name === name);
              if (!cmd?.action) return null;
              // Build a minimal context; submit_prompt actions only need
              // invocation + services.config, not UI state.
              const minimalContext = {
                executionMode: 'non_interactive' as const,
                invocation: {
                  raw: args ? `/${name} ${args}` : `/${name}`,
                  name,
                  args,
                },
                services: { config, settings, logger: null },
              } as unknown as Parameters<typeof cmd.action>[0];
              const result = await cmd.action(minimalContext, args);
              if (!result || result.type !== 'submit_prompt') return null;
              const output = hasUserPromptExpansionHooks(config)
                ? await config
                    .getHookSystem()
                    ?.fireUserPromptExpansionEvent(
                      name,
                      args,
                      serializeUserPromptExpansionPrompt(result.content),
                      controller.signal,
                    )
                : undefined;
              if (controller.signal.aborted) {
                return { error: 'Skill execution cancelled by user.' };
              }
              if (output) {
                const blockingError = output.getBlockingError();
                if (blockingError.blocked || output.shouldStopExecution()) {
                  return {
                    error: formatUserPromptExpansionBlockedMessage(
                      blockingError.reason || output.getEffectiveReason(),
                    ),
                  };
                }
              }
              const content = appendUserPromptExpansionAdditionalContext(
                result.content,
                output?.getAdditionalContext(),
              );
              if (typeof content === 'string') return content;
              if (Array.isArray(content)) {
                return content
                  .map((p) =>
                    typeof p === 'string'
                      ? p
                      : ((p as { text?: string }).text ?? ''),
                  )
                  .join('');
              }
              return null;
            },
          );
        }
        setCommands(commandService.getCommandsForMode('interactive'));
      } catch (error) {
        debugLogger.error('Failed to load slash commands:', error);
      } finally {
        if (!controller.signal.aborted) {
          resolveCommandReloads(reloadTrigger);
        }
      }
    };

    load();

    return () => {
      controller.abort();
    };
  }, [
    config,
    reloadTrigger,
    isConfigInitialized,
    settings,
    resolveCommandReloads,
  ]);

  const handleSlashCommand = useCallback(
    async (
      rawQuery: PartListUnion,
      oneTimeShellAllowlist?: Set<string>,
      overwriteConfirmed?: boolean,
      existingInvocationItemId?: number,
    ): Promise<SlashCommandProcessorResult | false> => {
      if (typeof rawQuery !== 'string') {
        return false;
      }

      const trimmed = rawQuery.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }
      if (trimmed.startsWith('/') && hasSlashCommandPathSeparator(trimmed)) {
        return false;
      }

      const recordedItems: HistoryItemWithoutId[] = [];
      const recordItem = (item: HistoryItemWithoutId) => {
        recordedItems.push(item);
      };
      const addItemWithRecording: UseHistoryManagerReturn['addItem'] = (
        item,
        timestamp,
      ) => {
        recordItem(item);
        return addItem(item, timestamp);
      };

      setIsProcessing(true);

      // Create a new AbortController for this command execution
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const userMessageTimestamp = Date.now();
      let invocationItemId = existingInvocationItemId;
      let invocationSentToModel = false;
      if (!isBtwCommand(trimmed) && invocationItemId === undefined) {
        invocationItemId = addItemWithRecording(
          { type: MessageType.USER, text: trimmed, sentToModel: false },
          userMessageTimestamp,
        );
      }

      let hasError = false;
      let delegatedToRecursiveInvocation = false;
      const {
        commandToExecute,
        args,
        canonicalPath: resolvedCommandPath,
      } = parseSlashCommand(trimmed, commands);

      const subcommand =
        resolvedCommandPath.length > 1
          ? resolvedCommandPath.slice(1).join(' ')
          : undefined;

      try {
        if (commandToExecute) {
          if (!commandToExecute.hidden) {
            setRecentCommands((previous) => {
              const next = new Map(previous);
              const existing = next.get(commandToExecute.name);
              next.set(commandToExecute.name, {
                name: commandToExecute.name,
                usedAt: Date.now(),
                count: (existing?.count ?? 0) + 1,
              });
              return next;
            });
          }
          if (commandToExecute.action) {
            const fullCommandContext: CommandContext = {
              ...commandContext,
              ui: {
                ...commandContext.ui,
                addItem: addItemWithRecording,
              },
              invocation: {
                raw: trimmed,
                name: commandToExecute.name,
                args,
              },
              overwriteConfirmed,
              abortSignal: abortController.signal,
            };

            // If a one-time list is provided for a "Proceed" action, temporarily
            // augment the session allowlist for this single execution.
            if (oneTimeShellAllowlist && oneTimeShellAllowlist.size > 0) {
              fullCommandContext.session = {
                ...fullCommandContext.session,
                sessionShellAllowlist: new Set([
                  ...fullCommandContext.session.sessionShellAllowlist,
                  ...oneTimeShellAllowlist,
                ]),
              };
            }
            // Race the command action against the abort signal so that
            // ESC cancellation immediately unblocks the await chain.
            // Without this, commands like /compress whose underlying
            // operation (tryCompressChat) doesn't accept an AbortSignal
            // would keep submitQuery stuck until the operation completes.
            const abortPromise = new Promise<undefined>((resolve) => {
              abortController.signal.addEventListener(
                'abort',
                () => resolve(undefined),
                { once: true },
              );
            });
            const result = await Promise.race([
              commandToExecute.action(fullCommandContext, args),
              abortPromise,
            ]);

            // If the command was cancelled via ESC while executing, skip result processing
            if (abortController.signal.aborted) {
              return { type: 'handled' };
            }

            if (result) {
              switch (result.type) {
                case 'tool':
                  return {
                    type: 'schedule_tool',
                    toolName: result.toolName,
                    toolArgs: result.toolArgs,
                  };
                case 'message':
                  if (result.messageType === 'info') {
                    addMessage({
                      type: MessageType.INFO,
                      content: result.content,
                      timestamp: new Date(),
                    });
                  } else if (result.messageType === 'warning') {
                    addMessage({
                      type: MessageType.WARNING,
                      content: result.content,
                      timestamp: new Date(),
                    });
                  } else {
                    addMessage({
                      type: MessageType.ERROR,
                      content: result.content,
                      timestamp: new Date(),
                    });
                  }
                  return { type: 'handled' };
                case 'dialog':
                  switch (result.dialog) {
                    case 'arena_start':
                      actions.openArenaDialog?.('start');
                      return { type: 'handled' };
                    case 'arena_select':
                      actions.openArenaDialog?.('select');
                      return { type: 'handled' };
                    case 'arena_stop':
                      actions.openArenaDialog?.('stop');
                      return { type: 'handled' };
                    case 'arena_status':
                      actions.openArenaDialog?.('status');
                      return { type: 'handled' };
                    case 'auth':
                      actions.openAuthDialog();
                      return { type: 'handled' };
                    case 'theme':
                      actions.openThemeDialog();
                      return { type: 'handled' };
                    case 'editor':
                      actions.openEditorDialog();
                      return { type: 'handled' };
                    case 'settings':
                      actions.openSettingsDialog();
                      return { type: 'handled' };
                    case 'statusline':
                      actions.openStatusLineDialog();
                      return { type: 'handled' };
                    case 'memory':
                      actions.openMemoryDialog();
                      return { type: 'handled' };
                    case 'model':
                      actions.openModelDialog();
                      return { type: 'handled' };
                    case 'fast-model':
                      actions.openModelDialog({ fastModelMode: true });
                      return { type: 'handled' };
                    case 'voice-model':
                      actions.openModelDialog({ voiceModelMode: true });
                      return { type: 'handled' };
                    case 'trust':
                      actions.openTrustDialog();
                      return { type: 'handled' };
                    case 'permissions':
                      actions.openPermissionsDialog();
                      return { type: 'handled' };
                    case 'subagent_create':
                      actions.openSubagentCreateDialog();
                      return { type: 'handled' };
                    case 'subagent_list':
                      actions.openAgentsManagerDialog();
                      return { type: 'handled' };
                    case 'skills_manage':
                      actions.openSkillsManagerDialog();
                      return { type: 'handled' };
                    case 'mcp':
                      actions.openMcpDialog();
                      return { type: 'handled' };
                    case 'hooks':
                      actions.openHooksDialog();
                      return { type: 'handled' };
                    case 'stats':
                      actions.openStatsDialog();
                      return { type: 'handled' };
                    case 'approval-mode':
                      actions.openApprovalModeDialog();
                      return { type: 'handled' };
                    case 'resume':
                      if (result.sessionId) {
                        await actions.handleResume(result.sessionId);
                      } else {
                        actions.openResumeDialog(result.matchedSessions);
                      }
                      return { type: 'handled' };
                    case 'branch':
                      // Must be awaited: `/branch` swaps core + UI session
                      // state asynchronously, and a non-awaited call lets
                      // this dispatcher return `handled` while the swap is
                      // still in flight. A fast follow-up prompt could then
                      // interleave with the swap and be recorded against
                      // the wrong session.
                      await actions.handleBranch(result.name);
                      return { type: 'handled' };
                    case 'delete':
                      actions.openDeleteDialog();
                      return { type: 'handled' };
                    case 'extensions_manage':
                      actions.openExtensionsManagerDialog();
                      return { type: 'handled' };
                    case 'rewind':
                      actions.openRewindSelector();
                      return { type: 'handled' };
                    case 'diff':
                      actions.openDiffDialog();
                      return { type: 'handled' };
                    case 'help':
                      actions.openHelpDialog();
                      return { type: 'handled' };
                    default: {
                      const unhandled: never = result.dialog;
                      throw new Error(
                        `Unhandled slash command result: ${unhandled}`,
                      );
                    }
                  }
                case 'load_history': {
                  config?.getGeminiClient()?.setHistory(result.clientHistory);
                  fullCommandContext.ui.clear();
                  result.history.forEach((item, index) => {
                    fullCommandContext.ui.addItem(item, index);
                  });
                  return { type: 'handled' };
                }

                case 'quit':
                  actions.quit(result.messages);
                  return { type: 'handled' };

                case 'submit_prompt': {
                  const invocation = fullCommandContext.invocation;
                  let content = result.content;
                  const output = hasUserPromptExpansionHooks(config)
                    ? await config
                        .getHookSystem()
                        ?.fireUserPromptExpansionEvent(
                          invocation?.name ?? '',
                          invocation?.args ?? '',
                          serializeUserPromptExpansionPrompt(content),
                          abortController.signal,
                        )
                    : undefined;
                  if (abortController.signal.aborted) {
                    hasError = true;
                    return { type: 'handled' };
                  }
                  if (output) {
                    const blockingError = output.getBlockingError();
                    if (blockingError.blocked || output.shouldStopExecution()) {
                      hasError = true;
                      addMessage({
                        type: MessageType.ERROR,
                        content: formatUserPromptExpansionBlockedMessage(
                          blockingError.reason || output.getEffectiveReason(),
                        ),
                        timestamp: new Date(),
                      });
                      return { type: 'handled' };
                    }
                    content = appendUserPromptExpansionAdditionalContext(
                      content,
                      output.getAdditionalContext(),
                    );
                  }
                  if (invocationItemId !== undefined) {
                    invocationSentToModel = true;
                    debugLogger.debug(
                      `Marked slash command invocation as model-sent: /${resolvedCommandPath.join(
                        ' ',
                      )}`,
                    );
                    // React applies this update asynchronously. No same-turn
                    // logic reads the UI history classification; rewind/resume
                    // consumers observe it after state has rendered.
                    updateItem(invocationItemId, { sentToModel: true });
                  }
                  return {
                    type: 'submit_prompt',
                    content,
                    onComplete: result.onComplete,
                  };
                }
                case 'confirm_shell_commands': {
                  const { outcome, approvedCommands } = await new Promise<{
                    outcome: ToolConfirmationOutcome;
                    approvedCommands?: string[];
                  }>((resolve) => {
                    setShellConfirmationRequest({
                      commands: result.commandsToConfirm,
                      onConfirm: (
                        resolvedOutcome,
                        resolvedApprovedCommands,
                      ) => {
                        setShellConfirmationRequest(null); // Close the dialog
                        resolve({
                          outcome: resolvedOutcome,
                          approvedCommands: resolvedApprovedCommands,
                        });
                      },
                    });
                  });

                  if (
                    outcome === ToolConfirmationOutcome.Cancel ||
                    !approvedCommands ||
                    approvedCommands.length === 0
                  ) {
                    return { type: 'handled' };
                  }

                  if (outcome === ToolConfirmationOutcome.ProceedAlways) {
                    setSessionShellAllowlist(
                      (prev) => new Set([...prev, ...approvedCommands]),
                    );
                  }

                  delegatedToRecursiveInvocation = true;
                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    // Pass the approved commands as a one-time grant for this execution.
                    new Set(approvedCommands),
                    undefined,
                    invocationItemId,
                  );
                }
                case 'confirm_action': {
                  const { confirmed } = await new Promise<{
                    confirmed: boolean;
                  }>((resolve) => {
                    setConfirmationRequest({
                      prompt: result.prompt,
                      onConfirm: (resolvedConfirmed) => {
                        setConfirmationRequest(null);
                        resolve({ confirmed: resolvedConfirmed });
                      },
                    });
                  });

                  if (!confirmed) {
                    addItemWithRecording(
                      {
                        type: MessageType.INFO,
                        text: 'Operation cancelled.',
                      },
                      Date.now(),
                    );
                    return { type: 'handled' };
                  }

                  delegatedToRecursiveInvocation = true;
                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    undefined,
                    true,
                    invocationItemId,
                  );
                }
                case 'stream_messages': {
                  // stream_messages is only used in ACP/Zed integration mode
                  // and should not be returned in interactive UI mode
                  throw new Error(
                    'stream_messages result type is not supported in interactive mode',
                  );
                }
                default: {
                  const unhandled: never = result;
                  throw new Error(
                    `Unhandled slash command result: ${unhandled}`,
                  );
                }
              }
            }

            return { type: 'handled' };
          } else if (commandToExecute.subCommands) {
            const helpText = `Command '/${commandToExecute.name}' requires a subcommand. Available:\n${commandToExecute.subCommands
              .map((sc) => `  - ${sc.name}: ${sc.description || ''}`)
              .join('\n')}`;
            addMessage({
              type: MessageType.INFO,
              content: helpText,
              timestamp: new Date(),
            });
            return { type: 'handled' };
          }
        }

        addMessage({
          type: MessageType.ERROR,
          content: `Unknown command: ${trimmed}`,
          timestamp: new Date(),
        });

        return { type: 'handled' };
      } catch (e: unknown) {
        // If cancelled via ESC, the cancelSlashCommand callback already handled cleanup
        if (abortController.signal.aborted) {
          return { type: 'handled' };
        }
        hasError = true;
        if (config) {
          const event = makeSlashCommandEvent({
            command: resolvedCommandPath[0],
            subcommand,
            status: SlashCommandStatus.ERROR,
          });
          logSlashCommand(config, event);
        }
        addItemWithRecording(
          {
            type: MessageType.ERROR,
            text: e instanceof Error ? e.message : String(e),
          },
          Date.now(),
        );
        return { type: 'handled' };
      } finally {
        if (config?.getChatRecordingService) {
          const chatRecorder = config.getChatRecordingService();
          const primaryCommand =
            resolvedCommandPath[0] ||
            trimmed.replace(/^[/?]/, '').split(/\s+/u)[0] ||
            trimmed;
          const shouldRecord =
            !delegatedToRecursiveInvocation &&
            !SLASH_COMMANDS_SKIP_RECORDING.has(primaryCommand);
          try {
            if (shouldRecord) {
              chatRecorder?.recordSlashCommand({
                phase: 'invocation',
                rawCommand: trimmed,
                sentToModel: invocationSentToModel,
              });
              const outputItems = recordedItems
                .filter((item) => item.type !== 'user')
                .map(serializeHistoryItemForRecording);
              chatRecorder?.recordSlashCommand({
                phase: 'result',
                rawCommand: trimmed,
                outputHistoryItems: outputItems,
              });
            }
          } catch (recordError) {
            debugLogger.error(
              '[slashCommand] Failed to record slash command:',
              recordError,
            );
          }
        }
        if (
          config &&
          resolvedCommandPath[0] &&
          !hasError &&
          !delegatedToRecursiveInvocation
        ) {
          const event = makeSlashCommandEvent({
            command: resolvedCommandPath[0],
            subcommand,
            status: SlashCommandStatus.SUCCESS,
          });
          logSlashCommand(config, event);
        }
        setIsProcessing(false);
      }
    },
    [
      config,
      addItem,
      actions,
      commands,
      commandContext,
      addMessage,
      setShellConfirmationRequest,
      setSessionShellAllowlist,
      setIsProcessing,
      setConfirmationRequest,
      updateItem,
    ],
  );

  return {
    handleSlashCommand,
    slashCommands: commands,
    recentSlashCommands: recentCommands,
    pendingHistoryItems,
    btwItem,
    setBtwItem,
    cancelBtw,
    cancelSlashCommand,
    commandContext,
    shellConfirmationRequest,
    confirmationRequest,
    // Exposed so dialogs (e.g. SkillsManagerDialog) can trigger a
    // CommandService rebuild without going through `commandContext.ui`,
    // which is plumbed only to slash-command actions, not arbitrary UI.
    reloadCommands,
  };
};
