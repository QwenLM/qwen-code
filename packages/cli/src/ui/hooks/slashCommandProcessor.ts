/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useEffect, useState } from 'react';
import { type PartListUnion } from '@google/genai';
import process from 'node:process';
import { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  Config,
  GitService,
  Logger,
  logSlashCommand,
  makeSlashCommandEvent,
  SlashCommandStatus,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import { formatDuration } from '../utils/formatters.js';
import { runExitCleanup } from '../../utils/cleanup.js';
import {
  Message,
  MessageType,
  HistoryItemWithoutId,
  HistoryItem,
  SlashCommandProcessorResult,
} from '../types.js';
import { LoadedSettings } from '../../config/settings.js';
import { type CommandContext, type SlashCommand } from '../commands/types.js';
import { CommandService } from '../../services/CommandService.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';

/**
 * Hook to define and process slash commands (e.g., /help, /clear).
 */
export const useSlashCommandProcessor = (
  config: Config | null,
  settings: LoadedSettings,
  addItem: UseHistoryManagerReturn['addItem'],
  clearItems: UseHistoryManagerReturn['clearItems'],
  loadHistory: UseHistoryManagerReturn['loadHistory'],
  refreshStatic: () => void,
  onDebugMessage: (message: string) => void,
  openThemeDialog: () => void,
  openAuthDialog: () => void,
  openEditorDialog: () => void,
  toggleCorgiMode: () => void,
  setQuittingMessages: (message: HistoryItem[]) => void,
  openPrivacyNotice: () => void,
  openSettingsDialog: () => void,
  openSubagentCreateDialog: () => void,
  openAgentsManagerDialog: () => void,
  toggleVimEnabled: () => Promise<boolean>,
  setIsProcessing: (isProcessing: boolean) => void,
  setGeminiMdFileCount: (count: number) => void,
  _showQuitConfirmation: () => void,
) => {
  const session = useSessionStats();
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  const reloadCommands = useCallback(() => {
    setReloadTrigger((v) => v + 1);
  }, []);
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
  const [quitConfirmationRequest, setQuitConfirmationRequest] =
    useState<null | {
      onConfirm: (shouldQuit: boolean, action?: string) => void;
    }>(null);

  const [sessionShellAllowlist, setSessionShellAllowlist] = useState(
    new Set<string>(),
  );
  const gitService = useMemo(() => {
    if (!config?.getProjectRoot()) {
      return;
    }
    return new GitService(config.getProjectRoot());
  }, [config]);

  const logger = useMemo(() => {
    const l = new Logger(config?.getSessionId() || '');
    // The logger's initialize is async, but we can create the instance
    // synchronously. Commands that use it will await its initialization.
    return l;
  }, [config]);

  const [pendingCompressionItem, setPendingCompressionItem] =
    useState<HistoryItemWithoutId | null>(null);

  const pendingHistoryItems = useMemo(() => {
    const items: HistoryItemWithoutId[] = [];
    if (pendingCompressionItem != null) {
      items.push(pendingCompressionItem);
    }
    return items;
  }, [pendingCompressionItem]);

  const addMessage = useCallback(
    (message: Message) => {
      // Convert Message to HistoryItemWithoutId
      let historyItemContent: HistoryItemWithoutId;
      if (message.type === MessageType.ABOUT) {
        historyItemContent = {
          type: 'about',
          cliVersion: message.cliVersion,
          osVersion: message.osVersion,
          sandboxEnv: message.sandboxEnv,
          modelVersion: message.modelVersion,
          selectedAuthType: message.selectedAuthType,
          gcpProject: message.gcpProject,
          ideClient: message.ideClient,
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
      } else if (message.type === MessageType.QUIT_CONFIRMATION) {
        historyItemContent = {
          type: 'quit_confirmation',
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
        git: gitService,
        logger,
      },
      ui: {
        addItem,
        clear: () => {
          clearItems();
          console.clear();
          refreshStatic();
        },
        loadHistory,
        setDebugMessage: onDebugMessage,
        pendingItem: pendingCompressionItem,
        setPendingItem: setPendingCompressionItem,
        toggleCorgiMode,
        toggleVimEnabled,
        setGeminiMdFileCount,
        reloadCommands,
      },
      session: {
        stats: session.stats,
        sessionShellAllowlist,
      },
    }),
    [
      config,
      settings,
      gitService,
      logger,
      loadHistory,
      addItem,
      clearItems,
      refreshStatic,
      session.stats,
      onDebugMessage,
      pendingCompressionItem,
      setPendingCompressionItem,
      toggleCorgiMode,
      toggleVimEnabled,
      sessionShellAllowlist,
      setGeminiMdFileCount,
      reloadCommands,
    ],
  );

  useEffect(() => {
    if (!config) {
      return;
    }

    const ideClient = config.getIdeClient();
    const listener = () => {
      reloadCommands();
    };

    ideClient.addStatusChangeListener(listener);

    return () => {
      ideClient.removeStatusChangeListener(listener);
    };
  }, [config, reloadCommands]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const loaders = [
        new McpPromptLoader(config),
        new BuiltinCommandLoader(config),
        new FileCommandLoader(config),
      ];
      const commandService = await CommandService.create(
        loaders,
        controller.signal,
      );
      setCommands(commandService.getCommands());
    };

    load();

    return () => {
      controller.abort();
    };
  }, [config, reloadTrigger]);

  const handleSlashCommand = useCallback(
    async (
      rawQuery: PartListUnion,
      oneTimeShellAllowlist?: Set<string>,
      overwriteConfirmed?: boolean,
    ): Promise<SlashCommandProcessorResult | false> => {
      if (typeof rawQuery !== 'string') {
        return false;
      }

      const trimmed = rawQuery.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }

      setIsProcessing(true);

      const userMessageTimestamp = Date.now();
      addItem({ type: MessageType.USER, text: trimmed }, userMessageTimestamp);

      const parts = trimmed.substring(1).trim().split(/\s+/);
      const commandPath = parts.filter((p) => p); // The parts of the command, e.g., ['memory', 'add']

      let currentCommands = commands;
      let commandToExecute: SlashCommand | undefined;
      let pathIndex = 0;
      let hasError = false;
      const canonicalPath: string[] = [];

      for (const part of commandPath) {
        // TODO: For better performance and architectural clarity, this two-pass
        // search could be replaced. A more optimal approach would be to
        // pre-compute a single lookup map in `CommandService.ts` that resolves
        // all name and alias conflicts during the initial loading phase. The
        // processor would then perform a single, fast lookup on that map.

        // First pass: check for an exact match on the primary command name.
        let foundCommand = currentCommands.find((cmd) => cmd.name === part);

        // Second pass: if no primary name matches, check for an alias.
        if (!foundCommand) {
          foundCommand = currentCommands.find((cmd) =>
            cmd.altNames?.includes(part),
          );
        }

        if (foundCommand) {
          commandToExecute = foundCommand;
          canonicalPath.push(foundCommand.name);
          pathIndex++;
          if (foundCommand.subCommands) {
            currentCommands = foundCommand.subCommands;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      const resolvedCommandPath = canonicalPath;
      const subcommand =
        resolvedCommandPath.length > 1
          ? resolvedCommandPath.slice(1).join(' ')
          : undefined;

      try {
        if (commandToExecute) {
          const args = parts.slice(pathIndex).join(' ');

          if (commandToExecute.action) {
            const fullCommandContext: CommandContext = {
              ...commandContext,
              invocation: {
                raw: trimmed,
                name: commandToExecute.name,
                args,
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
                  };
                case 'message':
                  if (result.messageType === 'info') {
                    addMessage({
                      type: MessageType.INFO,
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
                    case 'auth':
                      openAuthDialog();
                      return { type: 'handled' };
                    case 'theme':
                      openThemeDialog();
                      return { type: 'handled' };
                    case 'editor':
                      openEditorDialog();
                      return { type: 'handled' };
                    case 'privacy':
                      openPrivacyNotice();
                      return { type: 'handled' };
                    case 'settings':
                      openSettingsDialog();
                      return { type: 'handled' };
                    case 'subagent_create':
                      openSubagentCreateDialog();
                      return { type: 'handled' };
                    case 'subagent_list':
                      openAgentsManagerDialog();
                      return { type: 'handled' };
                    case 'help':
                      return { type: 'handled' };
                    default: {
                      const unhandled: never = result.dialog;
                      throw new Error(
                        `Unhandled slash command result: ${unhandled}`,
                      );
                    }
                  }
                case 'load_history': {
                  await config
                    ?.getGeminiClient()
                    ?.setHistory(result.clientHistory);
                  fullCommandContext.ui.clear();
                  result.history.forEach((item, index) => {
                    fullCommandContext.ui.addItem(item, index);
                  });
                  return { type: 'handled' };
                }
                case 'quit_confirmation':
                  // Show quit confirmation dialog instead of immediately quitting
                  setQuitConfirmationRequest({
                    onConfirm: (shouldQuit: boolean, action?: string) => {
                      setQuitConfirmationRequest(null);
                      if (!shouldQuit) {
                        // User cancelled the quit operation - do nothing
                        return;
                      }
                      if (shouldQuit) {
                        if (action === 'save_and_quit') {
                          // First save conversation with auto-generated tag, then quit
                          const timestamp = new Date()
                            .toISOString()
                            .replace(/[:.]/g, '-');
                          const autoSaveTag = `auto-save chat ${timestamp}`;
                          handleSlashCommand(`/chat save "${autoSaveTag}"`);
                          setTimeout(() => handleSlashCommand('/quit'), 100);
                        } else if (action === 'summary_and_quit') {
                          // Generate summary and then quit
                          handleSlashCommand('/summary')
                            .then(() => {
                              // Wait for user to see the summary result
                              setTimeout(() => {
                                handleSlashCommand('/quit');
                              }, 1200);
                            })
                            .catch((error) => {
                              // If summary fails, still quit but show error
                              addItem(
                                {
                                  type: 'error',
                                  text: `Failed to generate summary before quit: ${
                                    error instanceof Error
                                      ? error.message
                                      : String(error)
                                  }`,
                                },
                                Date.now(),
                              );
                              // Give user time to see the error message
                              setTimeout(() => {
                                handleSlashCommand('/quit');
                              }, 1000);
                            });
                        } else {
                          // Just quit immediately - trigger the actual quit action
                          const now = Date.now();
                          const { sessionStartTime } = session.stats;
                          const wallDuration = now - sessionStartTime.getTime();

                          setQuittingMessages([
                            {
                              type: 'user',
                              text: `/quit`,
                              id: now - 1,
                            },
                            {
                              type: 'quit',
                              duration: formatDuration(wallDuration),
                              id: now,
                            },
                          ]);
                          setTimeout(async () => {
                            await runExitCleanup();
                            process.exit(0);
                          }, 100);
                        }
                      }
                    },
                  });
                  return { type: 'handled' };

                case 'quit':
                  setQuittingMessages(result.messages);
                  setTimeout(async () => {
                    await runExitCleanup();
                    process.exit(0);
                  }, 100);
                  return { type: 'handled' };

                case 'submit_prompt':
                  return {
                    type: 'submit_prompt',
                    content: result.content,
                  };
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

                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    // Pass the approved commands as a one-time grant for this execution.
                    new Set(approvedCommands),
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
                    addItem(
                      {
                        type: MessageType.INFO,
                        text: 'Operation cancelled.',
                      },
                      Date.now(),
                    );
                    return { type: 'handled' };
                  }

                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    undefined,
                    true,
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
        hasError = true;
        if (config) {
          const event = makeSlashCommandEvent({
            command: resolvedCommandPath[0],
            subcommand,
            status: SlashCommandStatus.ERROR,
          });
          logSlashCommand(config, event);
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
        if (config && resolvedCommandPath[0] && !hasError) {
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
      openAuthDialog,
      commands,
      commandContext,
      addMessage,
      openThemeDialog,
      openPrivacyNotice,
      openEditorDialog,
      setQuittingMessages,
      openSettingsDialog,
      openSubagentCreateDialog,
      openAgentsManagerDialog,
      setShellConfirmationRequest,
      setSessionShellAllowlist,
      setIsProcessing,
      setConfirmationRequest,
      session.stats,
    ],
  );

  return {
    handleSlashCommand,
    slashCommands: commands,
    pendingHistoryItems,
    commandContext,
    shellConfirmationRequest,
    confirmationRequest,
    quitConfirmationRequest,
  };
};
