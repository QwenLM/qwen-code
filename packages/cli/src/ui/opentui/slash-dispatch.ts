/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Slash-command dispatch for the OpenTUI renderer (PR1 slice 1).
 *
 * Parses '/'-prefixed input and dispatches into the ORIGINAL command
 * registry: the same loader stack (MCP prompts, built-ins, bundled skills,
 * skill dirs, saved workflows, file commands) and `CommandService` the ink
 * `useSlashCommandProcessor` builds, resolved through the shared
 * `parseSlashCommand` so name/alias/subcommand resolution is identical.
 *
 * Slice 1 scope: dispatch + help. Command results are mapped onto neutral
 * effects the OpenTUI backend applies (message, help overlay, clear, quit,
 * submit-to-model); dialogs beyond help report themselves as pending parity.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../commands/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { BundledSkillLoader } from '../../services/BundledSkillLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { SavedWorkflowLoader } from '../../services/saved-workflow-loader.js';
import { SkillCommandLoader } from '../../services/SkillCommandLoader.js';
import { CommandService } from '../../services/CommandService.js';
import { parseSlashCommand } from './slash-command-parse.js';
import { hasSlashCommandPathSeparator } from '../utils/commandUtils.js';
import {
  appendUserPromptExpansionAdditionalContext,
  formatUserPromptExpansionBlockedMessage,
  serializeUserPromptExpansionPrompt,
} from '../../utils/userPromptExpansionHook.js';

function hasUserPromptExpansionHooks(config: Config | null): boolean {
  return (
    !!config &&
    !config.getDisableAllHooks?.() &&
    (config.hasHooksForEvent?.('UserPromptExpansion') ?? false)
  );
}

/**
 * Builds the interactive command list exactly like the ink processor does
 * (same loader order, same disabled-command denylist, same mode filter), and
 * registers the model-invocable commands provider/executor on the config
 * (ink loader-effect parity): without them the startup snapshot and per-turn
 * drain miss bundled skills, file commands, and MCP prompts, and SkillTool
 * cannot invoke model-invocable commands that are not file-based skills.
 */
export async function loadInteractiveCommands(
  config: Config | null,
  signal?: AbortSignal,
  settings?: LoadedSettings | null,
): Promise<readonly SlashCommand[]> {
  // Skill/MCP/project commands need the config fully initialized (the skill
  // manager is created in initialize()); without this /skills errors and
  // skill commands are missing from /-completion.
  try {
    await config?.initialize();
  } catch {
    /* proceed with partial commands */
  }
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
    signal ?? new AbortController().signal,
    disabled.length > 0 ? new Set(disabled) : undefined,
  );
  if (config) {
    config.setModelInvocableCommandsProvider(() =>
      commandService.getModelInvocableCommands().map((cmd) => ({
        name: cmd.name,
        description: cmd.modelDescription ?? cmd.description,
      })),
    );
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
          services: { config, settings: settings ?? null, logger: null },
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
                signal ?? new AbortController().signal,
              )
          : undefined;
        if (signal?.aborted) {
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
              typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''),
            )
            .join('');
        }
        return null;
      },
    );
  }
  return commandService.getCommandsForMode('interactive');
}

/**
 * Whether the submitted text must be treated as a slash command. Mirrors the
 * ink processor guard: '/' or '?' prefix, but not file-path-like input.
 */
export function isSlashCommandInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
    return false;
  }
  if (trimmed.startsWith('/') && hasSlashCommandPathSeparator(trimmed)) {
    return false;
  }
  return true;
}

export type SlashResolution =
  | { type: 'unknown'; input: string }
  | {
      type: 'command';
      command: SlashCommand;
      args: string;
      canonicalPath: string[];
    };

/** Resolves '/name args' against the registry via the shared parser. */
export function resolveSlashCommand(
  raw: string,
  commands: readonly SlashCommand[],
): SlashResolution {
  const trimmed = raw.trim();
  const { commandToExecute, args, canonicalPath } = parseSlashCommand(
    trimmed,
    commands,
  );
  if (!commandToExecute) {
    return { type: 'unknown', input: trimmed };
  }
  return { type: 'command', command: commandToExecute, args, canonicalPath };
}

/** Neutral effects the OpenTUI backend applies for a dispatched command. */
export type SlashEffect =
  | { kind: 'handled' }
  | {
      kind: 'message';
      messageType: 'info' | 'warning' | 'error';
      content: string;
    }
  | { kind: 'help' }
  | { kind: 'dialog'; dialog: string; command: string }
  | { kind: 'clear' }
  | { kind: 'quit' }
  | { kind: 'submit'; content: string };

export interface SlashDispatchEnv {
  config: Config | null;
  /** Optional loaded settings; commands reading settings receive them. */
  settings?: LoadedSettings | null;
  abortSignal?: AbortSignal;
}

function stringifyPromptContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : ((part as { text?: string }).text ?? ''),
      )
      .join('');
  }
  return String(content ?? '');
}

function mapActionResult(
  result: SlashCommandActionReturn | void,
  command: SlashCommand,
): SlashEffect {
  if (!result) {
    return { kind: 'handled' };
  }
  switch (result.type) {
    case 'message':
      return {
        kind: 'message',
        messageType: result.messageType,
        content: result.content,
      };
    case 'dialog':
      return result.dialog === 'help'
        ? { kind: 'help' }
        : { kind: 'dialog', dialog: result.dialog, command: command.name };
    case 'quit':
      return { kind: 'quit' };
    case 'load_history':
      return result.history.length === 0
        ? { kind: 'clear' }
        : {
            kind: 'message',
            messageType: 'info',
            content: `'/${command.name}' history restore is not yet available in the OpenTUI renderer.`,
          };
    case 'submit_prompt':
      return {
        kind: 'submit',
        content: stringifyPromptContent(result.content),
      };
    case 'tool':
      return {
        kind: 'message',
        messageType: 'info',
        content: `Tool scheduling for '/${command.name}' is not yet available in the OpenTUI renderer.`,
      };
    case 'goal_control':
      return {
        kind: 'message',
        messageType: 'info',
        content: `Goal controls are not yet available in the OpenTUI renderer.`,
      };
    case 'confirm_shell_commands':
    case 'confirm_action':
      return {
        kind: 'message',
        messageType: 'info',
        content: `'/${command.name}' needs a confirmation dialog, which is not yet available in the OpenTUI renderer.`,
      };
    case 'stream_messages':
      return {
        kind: 'message',
        messageType: 'error',
        content:
          'stream_messages result type is not supported in interactive mode',
      };
    default: {
      const unhandled: never = result;
      return {
        kind: 'message',
        messageType: 'error',
        content: `Unhandled slash command result: ${unhandled}`,
      };
    }
  }
}

/**
 * Dispatches one slash command end-to-end and returns the effect to apply.
 * Mirrors the ink processor: unknown commands produce the same
 * `Unknown command: <input>` error; parent commands without an action list
 * their subcommands.
 */
export async function executeSlashCommand(
  raw: string,
  commands: readonly SlashCommand[],
  env: SlashDispatchEnv,
): Promise<SlashEffect> {
  const resolution = resolveSlashCommand(raw, commands);
  if (resolution.type === 'unknown') {
    return {
      kind: 'message',
      messageType: 'error',
      content: `Unknown command: ${resolution.input}`,
    };
  }

  const { command, args } = resolution;
  if (!command.action) {
    if (command.subCommands && command.subCommands.length > 0) {
      const helpText = `Command '/${command.name}' requires a subcommand. Available:\n${command.subCommands
        .map((sc) => `  - ${sc.name}: ${sc.description || ''}`)
        .join('\n')}`;
      return { kind: 'message', messageType: 'info', content: helpText };
    }
    return { kind: 'handled' };
  }

  const context = {
    executionMode: 'interactive',
    invocation: { raw: raw.trim(), name: command.name, args },
    services: {
      config: env.config,
      settings: env.settings ?? null,
      logger: null,
    },
    ui: {
      history: [],
      addItem: () => 0,
      clear: () => {},
      setDebugMessage: () => {},
      pendingItem: null,
      setPendingItem: () => {},
      btwItem: null,
      setBtwItem: () => {},
      cancelBtw: () => {},
      btwAbortControllerRef: { current: null },
      isIdleRef: { current: true },
      loadHistory: () => {},
      refreshStatic: () => {},
      toggleVimEnabled: async () => false,
      setGeminiMdFileCount: () => {},
      reloadCommands: () => {},
      setSessionName: () => {},
      extensionsUpdateState: new Map(),
      dispatchExtensionStateUpdate: () => {},
      addConfirmUpdateExtensionRequest: () => {},
    },
    session: {
      // Commands such as /quit read session timing stats; supply a minimal,
      // well-formed shape so they behave instead of throwing.
      stats: {
        sessionId: '',
        sessionStartTime: new Date(),
        metrics: {},
        lastPromptTokenCount: 0,
        promptCount: 0,
      },
      sessionShellAllowlist: new Set<string>(),
    },
    abortSignal: env.abortSignal,
  } as unknown as CommandContext;

  try {
    const result = await command.action(context, args);
    return mapActionResult(result, command);
  } catch (error) {
    return {
      kind: 'message',
      messageType: 'error',
      content: `Command '/${command.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
