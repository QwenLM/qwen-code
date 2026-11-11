/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  useCallback,
  useMemo,
  useEffect,
  useState,
  useRef,
} from 'react';
import { type PartListUnion } from '@google/genai';
import process from 'node:process';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  Logger,
  SHELL_TOOL_NAME,
  Storage,
  coreEvents,
  CoreEvent,
  sessionLogger,
  MCPDiscoveryState,
  CoreToolCallStatus,
  isCommandStyleUserPromptText,
  summarizeDiagnosticText,
  runLogger,
  isAbortError,
  pickQueryOverrides,
  filterOrphanedImages,
  type Config,
  type AgentDefinition,
  type SessionResumeData,
  type Message,
  type HookEventName,
  type PendingHookOutput,
  type PastedContent,
} from '@qwen-code/core';
import { useSessionStats } from '../contexts/SessionContext.js';
import type {
  FeedbackMessage,
  HistoryItemWithoutId,
  SlashCommandProcessorResult,
  HistoryItem,
  ConfirmationRequest,
} from '../types.js';
import { MessageType } from '../types.js';
import { createLocalCommandResultItem } from '../utils/localCommandResult.js';
import type { LoadedSettings } from '../../config/settings.js';
import { useI18nService } from '../i18n/I18nServiceContext.js';
import { type CommandContext, type SlashCommand } from '../commands/types.js';
import { CommandService } from '../../services/CommandService.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { SkillCommandLoader } from '../../services/SkillCommandLoader.js';
import { PluginCommandLoader } from '../../services/PluginCommandLoader.js';
import { WorkflowCommandLoader } from '../../services/WorkflowCommandLoader.js';
import { waitForSlashCommandReady } from '../../startup/startupModePolicy.js';
import { parseSlashCommand } from '../../utils/commands.js';
import { extractPotentialCommandStyleToken } from '../../utils/slashCommandToken.js';
import type { RunManualCompress } from './localSession.shared.js';
import {
  type ExtensionUpdateAction,
  type ExtensionUpdateStatus,
} from '../state/extensions.js';
import { useFullScreenPanel } from '../contexts/FullScreenPanelContext.js';

interface SlashCommandProcessorActions {
  openThemeDialog: () => void;
  openEditorDialog: () => void;
  openSettingsDialog: () => void;
  openSessionBrowser: (
    options?: import('./useSessionBrowser.js').SessionBrowserOpenOptions,
  ) => void;
  openRewindDialog: () => void;
  openAgentConfigDialog: (name: string, definition: AgentDefinition) => void;
  openAgentBrowser: () => void;
  openSkillBrowser: () => void;
  openPluginBrowser: (args?: string) => void;
  openMcpBrowser: () => void;
  openMcpApprovalDialog: (
    pending: Record<string, import('@qwen-code/core').MCPServerConfig>,
  ) => void;
  openHookBrowser: () => void;
  quit: (messages: HistoryItem[]) => void;
  setDebugMessage: (message: string) => void;
  toggleCorgiMode: () => void;
  toggleDebugProfiler: () => void;
  dispatchExtensionStateUpdate: (action: ExtensionUpdateAction) => void;
  addConfirmUpdateExtensionRequest: (
    request: ConfirmationRequest | null,
  ) => void;
  toggleShortcutsHelp: () => void;
  setText: (text: string) => void;
  viewWorkflowSessions: () => void;
  viewMainSession: () => void;
}

/**
 * Upper bound on how long a slash command typed during startup waits for the
 * command catalog. Nothing bounds skill discovery itself and StartupRuntime
 * gates have no internal timeout, so this is the backstop that keeps a hung gate
 * from looking like a frozen TUI.
 */
const COMMAND_CATALOG_WAIT_TIMEOUT_MS = 10_000;

/** How a slash command invocation ended, as recorded in the session event log. */
type SlashCommandTerminalStatus = 'success' | 'error' | 'cancelled';

/**
 * One user-visible slash command invocation. A command that re-runs itself
 * (approved shell expansion, confirmed action) passes this to the nested call
 * so both share one invocation id and only the outer call logs the lifecycle,
 * with the nested call's terminal status.
 */
interface SlashCommandInvocation {
  invocationId: string;
  terminalStatus?: SlashCommandTerminalStatus;
}

interface CatalogSettledSignal {
  promise: Promise<void>;
  resolve: () => void;
}

function createCatalogSettledSignal(): CatalogSettledSignal {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Hook to define and process slash commands (e.g., /help, /clear).
 */
export const useSlashCommandProcessor = (
  config: Config | null,
  settings: LoadedSettings,
  addItem: UseHistoryManagerReturn['addItem'],
  updateItem: UseHistoryManagerReturn['updateItem'],
  clearItems: UseHistoryManagerReturn['clearItems'],
  loadHistory: UseHistoryManagerReturn['loadHistory'],
  replaceMessages: (messages: Message[], sessionId?: string) => Promise<void>,
  resumeSession: (resumedSessionData: SessionResumeData) => Promise<boolean>,
  clearConversation: () => void,
  requestViewportReset: () => void,
  toggleVimEnabled: () => Promise<boolean>,
  setIsProcessing: (isProcessing: boolean) => void,
  actions: SlashCommandProcessorActions,
  extensionsUpdateState: Map<string, ExtensionUpdateStatus>,
  isConfigInitialized: boolean,
  setCustomDialog: (dialog: React.ReactNode | null) => boolean | void,
  setFullScreenDialog: (dialog: React.ReactNode | null) => void,
  // Conversation history access from the local session owner
  getMessages?: () => readonly Message[],
  setMessages?: (updater: (prev: Message[]) => Message[]) => void,
  clearAssemblerCache?: () => void,
  recordMessage?: (message: Message) => Promise<void>,
  runManualCompress?: RunManualCompress,
  ensurePromptBuildResult?: CommandContext['ensurePromptBuildResult'],
  queueHookContext?: (
    context: string,
    hookEventName?: HookEventName,
    sourceType?: PendingHookOutput['sourceType'],
  ) => void,
  sessionHandle?: CommandContext['services']['sessionHandle'],
) => {
  const session = useSessionStats();
  const { actions: fullScreenPanelActions } = useFullScreenPanel();
  const [commands, setCommands] = useState<readonly SlashCommand[] | undefined>(
    undefined,
  );
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // A ref mirror of `commands`, the last load error, and a one-shot "a usable
  // catalog landed" signal. `handleSlashCommand` awaits the catalog when a
  // command is dispatched before startup finishes, and after that await the
  // useCallback's captured `commands` is permanently stale — these refs are the
  // only values guaranteed fresh. The signal is created once and deliberately
  // survives loader-effect re-arms: opening the `commands` gate also triggers a
  // reload (config.ts markReady + emitSkillChange), so the arming that passes
  // the gate is routinely aborted before it installs anything.
  const commandsRef = useRef<readonly SlashCommand[] | undefined>(undefined);
  const commandLoadErrorRef = useRef<string | null>(null);
  const catalogSettledRef = useRef<CatalogSettledSignal>(
    createCatalogSettledSignal(),
  );

  const reloadCommands = useCallback(() => {
    setReloadTrigger((v) => v + 1);
  }, []);
  const [confirmationRequest, setConfirmationRequest] =
    useState<ConfirmationRequest | null>(null);
  const [activeProgressMessage, setActiveProgressMessage] = useState<
    string | undefined
  >();

  const [sessionShellAllowlist, setSessionShellAllowlist] = useState(
    new Set<string>(),
  );
  const { locale: uiLocale } = useI18nService();
  const logger = useMemo(() => {
    const l = new Logger(
      config?.getSessionId() || '',
      config?.storage ?? new Storage(process.cwd()),
    );
    // The logger's initialize is async, but we can create the instance
    // synchronously. Commands that use it will await its initialization.
    return l;
  }, [config]);

  const [pendingItem, setPendingItem] = useState<HistoryItemWithoutId | null>(
    null,
  );

  const cancellableCallbacksRef = useRef<Set<() => void>>(new Set());

  const pendingHistoryItems = useMemo(() => {
    const items: HistoryItemWithoutId[] = [];
    if (pendingItem != null) {
      items.push(pendingItem);
    }
    return items;
  }, [pendingItem]);

  const addMessage = useCallback(
    (message: FeedbackMessage) => {
      // Convert FeedbackMessage to HistoryItemWithoutId
      let historyItemContent: HistoryItemWithoutId;
      if (message.type === MessageType.ABOUT) {
        historyItemContent = {
          type: 'about',
          cliVersion: message.cliVersion,
          osVersion: message.osVersion,
          modelVersion: message.modelVersion,
          selectedAuthType: message.selectedAuthType,
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
    (): CommandContext =>
      ({
        services: {
          agentContext: config,
          settings,
          logger,
          sessionHandle,
        },
        ui: {
          locale: uiLocale,
          addItem,
          updateItem,
          clear: () => {
            actions.viewMainSession();
            clearItems();
            clearConversation();
            clearAssemblerCache?.();
          },
          loadHistory: async (history, postLoadInput, options) => {
            if (options?.messages) {
              await replaceMessages(options.messages);
            }
            const hasConcreteIds =
              history.length > 0 &&
              history.every(
                (item): item is HistoryItem =>
                  'id' in item && typeof item.id === 'number',
              );
            if (hasConcreteIds) {
              loadHistory(history as HistoryItem[]);
            } else {
              clearItems();
              history.forEach((item, index) => {
                addItem(item, index, true);
              });
            }
            requestViewportReset();
            if (postLoadInput !== undefined) {
              actions.setText(postLoadInput);
            }
          },
          resumeSession: async (resumedSessionData, postLoadInput) => {
            const didResume = await resumeSession(resumedSessionData);
            if (didResume && postLoadInput !== undefined) {
              actions.setText(postLoadInput);
            }
            return didResume;
          },
          setDebugMessage: actions.setDebugMessage,
          pendingItem,
          setPendingItem,
          toggleCorgiMode: actions.toggleCorgiMode,
          toggleDebugProfiler: actions.toggleDebugProfiler,
          toggleVimEnabled,
          reloadCommands,
          openAgentConfigDialog: actions.openAgentConfigDialog,
          extensionsUpdateState,
          dispatchExtensionStateUpdate: actions.dispatchExtensionStateUpdate,
          addConfirmUpdateExtensionRequest:
            actions.addConfirmUpdateExtensionRequest,
          setConfirmationRequest,
          removeComponent: () => setCustomDialog(null),
          removeFullScreenComponent: () => setFullScreenDialog(null),
          setFullScreenComponent: (content: React.ReactNode) =>
            setFullScreenDialog(content),
          viewWorkflowSessions: actions.viewWorkflowSessions,
          fullScreenPanel: fullScreenPanelActions,
          toggleShortcutsHelp: actions.toggleShortcutsHelp,
          setCustomDialog,
          registerCancellable: (callback: () => void) => {
            cancellableCallbacksRef.current.add(callback);
            return () => {
              cancellableCallbacksRef.current.delete(callback);
            };
          },
        },
        session: {
          stats: session.stats,
          sessionShellAllowlist,
        },
        // Conversation history from the local session owner (for slash commands)
        messages: getMessages?.(),
        setMessages,
        recordMessage,
        runManualCompress,
        ensurePromptBuildResult,
        queueHookContext,
      }),
    [
      config,
      settings,
      uiLocale,
      logger,
      loadHistory,
      addItem,
      updateItem,
      clearItems,
      clearConversation,
      requestViewportReset,
      session.stats,
      actions,
      pendingItem,
      setPendingItem,
      setConfirmationRequest,
      toggleVimEnabled,
      sessionShellAllowlist,
      reloadCommands,
      extensionsUpdateState,
      setCustomDialog,
      setFullScreenDialog,
      replaceMessages,
      resumeSession,
      fullScreenPanelActions,
      sessionHandle,
      getMessages,
      setMessages,
      clearAssemblerCache,
      recordMessage,
      runManualCompress,
      ensurePromptBuildResult,
      queueHookContext,
    ],
  );

  useEffect(() => {
    if (!config) {
      return;
    }

    const startupRuntime = config.getStartupRuntime();

    // `onChange` is the only *event-driven* reload path. It carries the
    // runtime's 175ms trailing / 700ms maxWait debounce, which matters because
    // every reload rebuilds the entire catalog (CommandService.create below).
    // User-initiated `context.ui.reloadCommands()` deliberately bypasses this
    // and stays immediate.
    //
    // Do not also subscribe to 'commands': emitSkillChange() emits both
    // 'skills' and 'commands' (config.ts), so that would rebuild twice per
    // skill change.
    const unregisterChangeListeners = [
      startupRuntime.onChange('mcp', reloadCommands),
      startupRuntime.onChange('extensions', reloadCommands),
      startupRuntime.onChange('dynamic-commands', reloadCommands),
      startupRuntime.onChange('skills', reloadCommands),
    ];

    // The raw event sources feed the debounced channel rather than reloading
    // directly, so bursts coalesce. Nothing else emits 'extensions', so this
    // bridge is what makes that channel live.
    const mcpStatusListener = () => {
      startupRuntime.emitChange('mcp');
    };
    const dynamicCommandsListener = () => {
      startupRuntime.emitChange('dynamic-commands');
    };

    // Listen for MCP server status changes (e.g. connection, discovery completion)
    // to reload slash commands (since they may include MCP prompts).
    coreEvents.on(CoreEvent.McpClientUpdate, mcpStatusListener);

    // TODO: Ideally this would happen more directly inside the ExtensionLoader,
    // but the CommandService today is not conducive to that since it isn't a
    // long lived service but instead gets fully re-created based on reload
    // events within this hook.
    const extensionEventListener = (_event: unknown) => {
      // We only care once at least one extension has completed
      // starting/stopping
      startupRuntime.emitChange('extensions');
    };
    coreEvents.on('extensionsStarting', extensionEventListener);
    coreEvents.on('extensionsStopping', extensionEventListener);
    coreEvents.on(CoreEvent.DynamicCommandsChanged, dynamicCommandsListener);

    return () => {
      for (const unregister of unregisterChangeListeners) {
        unregister();
      }
      coreEvents.off(CoreEvent.McpClientUpdate, mcpStatusListener);
      coreEvents.off('extensionsStarting', extensionEventListener);
      coreEvents.off('extensionsStopping', extensionEventListener);
      coreEvents.off(CoreEvent.DynamicCommandsChanged, dynamicCommandsListener);
    };
  }, [config, reloadCommands]);

  // Skill changes are handled by the `onChange('skills')` subscription above
  // rather than `config.onSkillChange`. Both are driven by the same
  // emitSkillChange() call sites, but the runtime channel is debounced —
  // which matters because three of those call sites fire during startup, one
  // of them immediately after the 'commands' gate opens.

  useEffect(() => {
    if (!config) {
      return;
    }

    const controller = new AbortController();
    const loadBuiltinFallbackCommands = async () => {
      try {
        return await new BuiltinCommandLoader(config).loadCommands(
          controller.signal,
        );
      } catch (fallbackErr) {
        runLogger.warn(
          'Failed to load config-backed built-in slash commands:',
          fallbackErr,
        );
        return new BuiltinCommandLoader(null).loadCommands(
          controller.signal,
        );
      }
    };

    // Release waiters in `handleSlashCommand` only when this arming reached a
    // terminal state. Never on an abort: an abort always means another arming
    // is on its way, and releasing there would hand the waiter no catalog at
    // all — the exact false "Unknown skill" this wait exists to prevent.
    const settleCatalog = () => {
      if (!controller.signal.aborted) {
        catalogSettledRef.current.resolve();
      }
    };
    const installCommands = (next: readonly SlashCommand[]) => {
      commandsRef.current = next;
      setCommands(next);
      settleCatalog();
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      try {
        commandLoadErrorRef.current = null;
        await config.waitForStartupGate('commands', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }

        const commandService = await CommandService.create(
          [
            new BuiltinCommandLoader(config),
            new SkillCommandLoader(config),
            new PluginCommandLoader(config),
            new WorkflowCommandLoader(config),
            new McpPromptLoader(config),
          ],
          controller.signal,
          config.getBuiltinPluginContributions(),
        );

        if (controller.signal.aborted) {
          return;
        }

        installCommands(commandService.getCommands());
        commandLoadErrorRef.current = null;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to load slash commands';
        commandLoadErrorRef.current = message;
        try {
          const fallbackCommands = await loadBuiltinFallbackCommands();
          if (controller.signal.aborted) {
            return;
          }
          const previousCommands = commandsRef.current;
          installCommands(
            previousCommands && previousCommands.length > 0
              ? previousCommands
              : CommandService.resolveFallbackCommands(
                  fallbackCommands,
                  controller.signal,
                  config.getBuiltinPluginContributions(),
                ),
          );
        } catch (fallbackErr) {
          // Terminal give-up: the load settled with no catalog at all. Release
          // waiters so they report the load error instead of timing out.
          settleCatalog();
          runLogger.warn('Failed to load fallback slash commands:', fallbackErr);
        }
        runLogger.warn('Failed to load slash commands:', err);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [config, reloadTrigger, isConfigInitialized]);

  const handleSlashCommand = useCallback(
    async (
      rawQuery: PartListUnion,
      oneTimeShellAllowlist?: Set<string>,
      overwriteConfirmed?: boolean,
      addToHistory: boolean = true,
      skipProcessingLock: boolean = false,
      pastedContents?: Record<number, PastedContent>,
      parentInvocation?: SlashCommandInvocation,
    ): Promise<SlashCommandProcessorResult | false> => {
      if (typeof rawQuery !== 'string') {
        return false;
      }

      const trimmed = rawQuery.trim();
      // Nested paths and source-code comments are unambiguously plain text.
      // Existing root paths remain candidates until the command catalog is
      // available, because a registered command must win over a same-named
      // filesystem entry.
      if (
        !isCommandStyleUserPromptText(trimmed, {
          commandCatalogReady: false,
        })
      ) {
        return false;
      }
      const ownsInvocation = parentInvocation === undefined;
      const invocation: SlashCommandInvocation = parentInvocation ?? {
        invocationId: randomUUID(),
      };
      const commandInvocationId = invocation.invocationId;
      // Only images whose [Image #N] placeholder survives in the command text
      // are forwarded to the command (e.g. /feedback attaches them).
      const invocationImages = pastedContents
        ? Object.fromEntries(
            Object.entries(filterOrphanedImages(pastedContents, trimmed)).filter(
              ([, c]) => c.type === 'image',
            ),
          )
        : undefined;
      const invocationPastedContents =
        invocationImages && Object.keys(invocationImages).length > 0
          ? invocationImages
          : undefined;
      // The command catalog lives behind the `commands` startup gate (skill
      // discovery), so a command typed right after the banner can arrive before
      // any catalog exists. Returning false here would make the caller report
      // "Unknown skill: model" for a perfectly valid built-in, so wait for the
      // catalog instead and then run the command the user already typed — the
      // headless path waits the same way (nonInteractiveCliCommands.ts).
      // Everything below this block may assume `activeCommands` is defined.
      let activeCommands = commands ?? commandsRef.current;
      if (activeCommands === undefined) {
        if (!config) {
          return false;
        }

        // Only wait for input that could actually name a command. Plain paths
        // like /etc/hosts reach this handler too and must go to the model.
        const pendingCommandName = extractPotentialCommandStyleToken(trimmed);
        if (!pendingCommandName) {
          return false;
        }
        const pendingCommandPrefix = trimmed[0];

        const controller = new AbortController();
        const cancel = () => controller.abort();
        cancellableCallbacksRef.current.add(cancel);
        // Unconditional, ignoring skipProcessingLock: Esc only reaches
        // triggerCancellableCallbacks while isProcessing is true, so suppressing
        // it here would make the wait uncancellable.
        setActiveProgressMessage('Loading commands...');
        setIsProcessing(true);
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            catalogSettledRef.current.promise,
            new Promise<void>((resolve) => {
              controller.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
            }),
            new Promise<void>((resolve) => {
              timeoutHandle = setTimeout(
                resolve,
                COMMAND_CATALOG_WAIT_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          cancellableCallbacksRef.current.delete(cancel);
          setActiveProgressMessage(undefined);
          setIsProcessing(false);
        }

        if (controller.signal.aborted) {
          return { type: 'handled' };
        }

        activeCommands = commandsRef.current;
        if (activeCommands === undefined) {
          sessionLogger.event({
            level: 'info',
            kind: 'input',
            type: 'input.slash_command.unknown',
            ids: {
              session_id: config?.getSessionId(),
            },
            data: {
              ...summarizeDiagnosticText(trimmed),
              catalog_ready: false,
            },
          });
          if (addToHistory) {
            addItem({ type: MessageType.USER, text: trimmed }, Date.now());
          }
          addItem(
            {
              type: MessageType.ERROR,
              text: commandLoadErrorRef.current
                ? `Slash commands are unavailable: ${commandLoadErrorRef.current}`
                : `Commands are still loading — ${pendingCommandPrefix}${pendingCommandName} is not available yet.`,
            },
            Date.now(),
          );
          return { type: 'handled' };
        }
      }

      const {
        commandToExecute,
        args,
        canonicalPath: resolvedCommandPath,
      } = parseSlashCommand(trimmed, activeCommands);

      if (
        !commandToExecute &&
        !isCommandStyleUserPromptText(trimmed, {
          commandCatalogReady: true,
        })
      ) {
        return false;
      }

      // If the input doesn't match any known command, check if MCP servers
      // are still loading (the command might come from an MCP server).
      // Otherwise, treat it as regular text input (e.g. file paths like
      // /home/user/file.txt) and let it be sent to the model.
      if (!commandToExecute) {
        sessionLogger.event({
          level: 'info',
          kind: 'input',
          type: 'input.slash_command.unknown',
          ids: {
            session_id: config?.getSessionId(),
          },
          data: {
            ...summarizeDiagnosticText(trimmed),
            // False here means the catalog landed empty — CommandService
            // swallows per-loader failures via Promise.allSettled, so a broken
            // BuiltinCommandLoader looks like "no commands exist" rather than an
            // error. Keeps that case distinguishable from a real typo.
            catalog_ready: activeCommands.length > 0,
          },
        });
        const isMcpLoading =
          config?.getMcpClientManager()?.getDiscoveryState() ===
          MCPDiscoveryState.IN_PROGRESS;
        if (isMcpLoading) {
          setIsProcessing(true);
          if (addToHistory) {
            addItem({ type: MessageType.USER, text: trimmed }, Date.now());
          }
          addMessage({
            type: MessageType.ERROR,
            content: `Unknown command: ${trimmed}. Command might have been from an MCP server but MCP servers are not done loading.`,
            timestamp: new Date(),
          });
          setIsProcessing(false);
          return { type: 'handled' };
        }
        return false;
      }

      const resolutionStatus =
        !commandToExecute.action && commandToExecute.subCommands
          ? 'missing_subcommand'
          : 'resolved';

      const waitForCommandStartupReady = async () => {
        if (!config) {
          return;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        cancellableCallbacksRef.current.add(cancel);
        try {
          await waitForSlashCommandReady(config, commandToExecute, {
            signal: controller.signal,
          });
        } finally {
          cancellableCallbacksRef.current.delete(cancel);
        }
      };

      if (commandToExecute.isInstant && commandToExecute.action) {
        const shouldShowProcessing =
          (commandToExecute.requiredStartupGates?.length ?? 0) > 0;
        if (shouldShowProcessing) {
          setIsProcessing(true);
        }
        try {
          await waitForCommandStartupReady();
        } catch (e: unknown) {
          if (isAbortError(e)) {
            return { type: 'handled' };
          }
          addItem(
            {
              type: MessageType.ERROR,
              text: e instanceof Error ? e.message : String(e),
            },
            Date.now(),
          );
          return { type: 'handled' };
        } finally {
          if (shouldShowProcessing) {
            setIsProcessing(false);
          }
        }

        const fullCommandContext: CommandContext = {
          ...commandContext,
          invocation: {
            raw: trimmed,
            name: commandToExecute.name,
            args,
            pastedContents: invocationPastedContents,
          },
          overwriteConfirmed,
        };
        void Promise.resolve()
          .then(() => commandToExecute.action?.(fullCommandContext, args))
          .then((result) => {
            const isResultError =
              (result?.type === 'message' &&
                result.messageType === 'error') ||
              (result?.type === 'local_command_result' &&
                result.severity === 'error');
            sessionLogger.event({
              level: isResultError ? 'error' : 'info',
              kind: isResultError ? 'error' : 'input',
              type: 'input.slash_command.finished',
              ids: {
                session_id: config?.getSessionId(),
              },
              data: {
                command_name: commandToExecute.name,
                command_path: resolvedCommandPath.join(' '),
                success: !isResultError,
              },
            });
          })
          .catch((error: unknown) => {
            const cancelled = isAbortError(error);
            sessionLogger.event({
              level: cancelled ? 'info' : 'error',
              kind: cancelled ? 'input' : 'error',
              type: 'input.slash_command.finished',
              ids: {
                session_id: config?.getSessionId(),
              },
              data: {
                command_name: commandToExecute.name,
                command_path: resolvedCommandPath.join(' '),
                success: false,
              },
            });
            if (!cancelled) {
              addItem(
                {
                  type: MessageType.ERROR,
                  text:
                    error instanceof Error ? error.message : String(error),
                },
                Date.now(),
              );
            }
          });
        return { type: 'handled' };
      }

      if (!skipProcessingLock) {
        setActiveProgressMessage(commandToExecute.progressMessage);
        setIsProcessing(true);
      }

      if (addToHistory && !commandToExecute.hideInput) {
        const userMessageTimestamp = Date.now();
        addItem(
          {
            type: MessageType.USER,
            text: trimmed,
            ...(commandToExecute.omitInputFromTranscript
              ? { omitFromTranscript: true }
              : {}),
          },
          userMessageTimestamp,
        );
      }

      let terminalStatus: SlashCommandTerminalStatus = 'success';
      if (ownsInvocation) {
        sessionLogger.event({
          level: 'info',
          kind: 'input',
          type: 'input.slash_command.started',
          ids: {
            session_id: config?.getSessionId(),
          },
          data: {
            ...summarizeDiagnosticText(trimmed),
            command_name: commandToExecute.name,
            command_path: resolvedCommandPath.join(' '),
            args_preview: summarizeDiagnosticText(args).text_preview,
            args_length: args.length,
            command_kind: commandToExecute.kind,
            plugin_name: commandToExecute.pluginName,
            mcp_server_name: commandToExecute.mcpServerName,
            safe_concurrent: commandToExecute.isSafeConcurrent === true,
          },
        });
      }

      try {
        await waitForCommandStartupReady();

        if (commandToExecute) {
          if (commandToExecute.action) {
            const fullCommandContext: CommandContext = {
              ...commandContext,
              invocation: {
                raw: trimmed,
                name: commandToExecute.name,
                args,
                pastedContents: invocationPastedContents,
              },
              overwriteConfirmed,
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
            const result = await commandToExecute.action(
              fullCommandContext,
              args,
            );

            if (result) {
              switch (result.type) {
                case 'tool':
                  return {
                    type: 'schedule_tool',
                    toolName: result.toolName,
                    toolArgs: result.toolArgs,
                    postSubmitPrompt: result.postSubmitPrompt,
                  };
                case 'message':
                  if (result.messageType === 'error') {
                    terminalStatus = 'error';
                  }
                  addItem(
                    {
                      type:
                        result.messageType === 'error'
                          ? MessageType.ERROR
                          : MessageType.INFO,
                      text: result.content,
                    },
                    Date.now(),
                  );
                  return { type: 'handled' };
                case 'local_command_result': {
                  if (result.severity === 'error') {
                    terminalStatus = 'error';
                  }
                  addItem(
                    createLocalCommandResultItem(result.text, result.severity),
                    Date.now(),
                  );
                  return { type: 'handled' };
                }
                case 'dialog':
                  switch (result.dialog) {
                    case 'theme':
                      actions.openThemeDialog();
                      return { type: 'handled' };
                    case 'editor':
                      actions.openEditorDialog();
                      return { type: 'handled' };
                    case 'sessionBrowser':
                      actions.openSessionBrowser(
                        result.props as
                          | import('./useSessionBrowser.js').SessionBrowserOpenOptions
                          | undefined,
                      );
                      return { type: 'handled' };
                    case 'rewind':
                      actions.openRewindDialog();
                      return { type: 'handled' };
                    case 'settings':
                      actions.openSettingsDialog();
                      return { type: 'handled' };
                    case 'agentBrowser':
                      actions.openAgentBrowser();
                      return { type: 'handled' };
                    case 'mcpBrowser':
                      actions.openMcpBrowser();
                      return { type: 'handled' };
                    case 'mcpApproval': {
                      const approvalProps = result.props as
                        | {
                            pending?: Record<
                              string,
                              import('@qwen-code/core').MCPServerConfig
                            >;
                          }
                        | undefined;
                      if (approvalProps?.pending) {
                        actions.openMcpApprovalDialog(approvalProps.pending);
                      }
                      return { type: 'handled' };
                    }
                    case 'hookBrowser':
                      actions.openHookBrowser();
                      return { type: 'handled' };
                    case 'skillBrowser':
                      actions.openSkillBrowser();
                      return { type: 'handled' };
                    case 'pluginBrowser': {
                      const pluginProps = result.props as
                        | { args?: string }
                        | undefined;
                      actions.openPluginBrowser(pluginProps?.args);
                      return { type: 'handled' };
                    }
                    case 'hookConfig':
                      // hookConfig is opened via uiActions from within HooksBrowser
                      return { type: 'handled' };
                    case 'agentConfig': {
                      const props = result.props as Record<string, unknown>;
                      if (
                        !props ||
                        // eslint-disable-next-line eslint-js/no-restricted-syntax
                        typeof props['name'] !== 'string' ||
                        !props['definition']
                      ) {
                        throw new Error(
                          'Received invalid properties for agentConfig dialog action.',
                        );
                      }

                      actions.openAgentConfigDialog(
                        props['name'],
                        props['definition'] as AgentDefinition,
                      );
                      return { type: 'handled' };
                    }
                    default: {
                      const unhandled: never = result.dialog;
                      throw new Error(
                        `Unhandled slash command result: ${unhandled}`,
                      );
                    }
                  }
                case 'load_history': {
                  // 清理旧会话后再替换真实历史，避免 clearConversation 清掉刚加载的消息。
                  fullCommandContext.ui.clear();
                  setMessages?.(() => [...result.clientHistory]);
                  result.history.forEach((item, index) => {
                    fullCommandContext.ui.addItem(item, index, true);
                  });
                  return { type: 'handled' };
                }
                case 'quit':
                  actions.quit(result.messages);
                  return { type: 'handled' };

                case 'submit_prompt':
                  return {
                    type: 'submit_prompt',
                    content: result.content,
                    isMeta: result.isMeta,
                    ...(result.isUserDecision ? { isUserDecision: true } : {}),
                    commandInvocationId,
                    skillActivation: result.skillActivation,
                    ...pickQueryOverrides(result),
                  };
                case 'confirm_shell_commands': {
                  // Judged by the real Shell check, one command at a time.
                  //
                  // This used to fabricate a queue item under the made-up tool name
                  // 'Expansion', which meant no rule the user wrote could ever match
                  // it: the same command was re-asked on every expansion even after
                  // an "always allow", and Yolo / DontAsk / Auto had no effect. Going
                  // through the module fixes all of that, and commands already
                  // covered by a rule now raise no prompt at all.
                  //
                  // The session grant deliberately stays in `sessionShellAllowlist`
                  // rather than being written as a `Bash(...)` rule: approving an
                  // expansion should not also let the model run that command.
                  const permission = config?.permission;
                  if (!permission) {
                    terminalStatus = 'cancelled';
                    addItem(
                      {
                        type: MessageType.ERROR,
                        text: 'Cannot confirm shell expansion: permissions are not available in this session.',
                      },
                      Date.now(),
                    );
                    return { type: 'handled' };
                  }

                  const approvedCommands: string[] = [];
                  let declined = false;

                  for (const command of result.commandsToConfirm) {
                    const callId = `expansion-${randomUUID()}`;
                    // The display and the prompt are matched by this id, which is
                    // how a real tool call ties its card to its queue entry.
                    setPendingItem({
                      type: 'tool_group',
                      tools: [
                        {
                          callId,
                          name: 'Expansion',
                          description: 'Command expansion needs shell access',
                          status: CoreToolCallStatus.AwaitingApproval,
                          isClientInitiated: true,
                          resultDisplay: undefined,
                          correlationId: callId,
                          confirmationDetails: {
                            type: 'exec' as const,
                            title: 'Confirm Shell Expansion',
                            command,
                            rootCommand: command,
                            rootCommands: [command],
                            commands: [command],
                          },
                        },
                      ],
                    });

                    let decision;
                    try {
                      decision = await permission.check({
                        toolName: SHELL_TOOL_NAME,
                        input: { command },
                        toolUseId: callId,
                      });
                    } finally {
                      setPendingItem(null);
                    }

                    if (decision.kind !== 'allow') {
                      declined = true;
                      break;
                    }
                    approvedCommands.push(command);
                  }

                  if (declined || approvedCommands.length === 0) {
                    terminalStatus = 'cancelled';
                    addItem(
                      {
                        type: MessageType.INFO,
                        text: 'Slash command shell execution declined.',
                      },
                      Date.now(),
                    );
                    return { type: 'handled' };
                  }

                  // Remembered for this session so a repeated expansion of the same
                  // command is not asked again, without widening the grant to the
                  // model's own Bash calls.
                  setSessionShellAllowlist(
                    (prev) => new Set([...prev, ...approvedCommands]),
                  );

                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    // Pass the approved commands as a one-time grant for this execution.
                    new Set(approvedCommands),
                    undefined,
                    false, // Do not add to history again
                    false,
                    undefined,
                    invocation,
                  );
                }
                case 'confirm_action': {
                  const { confirmed } = await new Promise<{
                    confirmed: boolean;
                  }>((resolve) => {
                    const completeConfirmation = (confirmed: boolean) => {
                      setConfirmationRequest(null);
                      resolve({ confirmed });
                    };
                    setConfirmationRequest({
                      prompt: result.prompt,
                      onConfirm: completeConfirmation,
                      onCancel: () => completeConfirmation(false),
                      showCancelOption: result.showCancelOption,
                      hideTitle: result.hideTitle,
                    });
                  });

                  if (!confirmed) {
                    terminalStatus = 'cancelled';
                    addItem(
                      {
                        type: MessageType.INFO,
                        text: 'Operation cancelled.',
                      },
                      Date.now(),
                    );
                    return { type: 'handled' };
                  }

                  if (result.onConfirm) {
                    await result.onConfirm();
                    return { type: 'handled' };
                  }

                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    undefined,
                    true,
                    true,
                    false,
                    undefined,
                    invocation,
                  );
                }
                case 'custom_dialog': {
                  const accepted = setCustomDialog(result.component);
                  if (accepted === false) {
                    addItem(
                      {
                        type: MessageType.INFO,
                        text: 'A dialog is already open. Close it first.',
                      },
                      Date.now(),
                    );
                  }
                  return { type: 'handled' };
                }
                case 'fullscreen_dialog': {
                  setFullScreenDialog(result.component);
                  return { type: 'handled' };
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

        return { type: 'handled' };
      } catch (e: unknown) {
        if (isAbortError(e)) {
          terminalStatus = 'cancelled';
          return { type: 'handled' };
        }
        terminalStatus = 'error';
        addItem(
          {
            type: MessageType.ERROR,
            text: e instanceof Error ? e.message : String(e),
          },
          Date.now(),
        );
        return { type: 'handled' };
      } finally {
        if (!ownsInvocation && resolutionStatus === 'resolved') {
          invocation.terminalStatus = terminalStatus;
        }
        const finalTerminalStatus = invocation.terminalStatus ?? terminalStatus;
        const commandSucceeded =
          resolutionStatus === 'resolved' && finalTerminalStatus === 'success';
        if (ownsInvocation) {
          sessionLogger.event({
            level: finalTerminalStatus === 'error' ? 'error' : 'info',
            kind: finalTerminalStatus === 'error' ? 'error' : 'input',
            type: 'input.slash_command.finished',
            ids: {
              session_id: config?.getSessionId(),
            },
            data: {
              command_name: commandToExecute.name,
              command_path: resolvedCommandPath.join(' '),
              success: commandSucceeded,
              status: finalTerminalStatus,
              resolution_status: resolutionStatus,
            },
          });
        }
        if (!skipProcessingLock) {
          setActiveProgressMessage(undefined);
          setIsProcessing(false);
        }
      }
    },
    [
      config,
      addItem,
      actions,
      commands,
      commandContext,
      addMessage,
      setSessionShellAllowlist,
      setIsProcessing,
      setConfirmationRequest,
      setCustomDialog,
      setMessages,
      setFullScreenDialog,
    ],
  );

  const triggerCancellableCallbacks = useCallback(() => {
    for (const cb of cancellableCallbacksRef.current) {
      try {
        cb();
      } catch {
        // Ignore errors from individual callbacks
      }
    }
    cancellableCallbacksRef.current.clear();
  }, []);

  return {
    handleSlashCommand,
    slashCommands: commands,
    pendingHistoryItems,
    commandContext,
    confirmationRequest,
    activeProgressMessage,
    reloadCommands,
    triggerCancellableCallbacks,
  };
};
