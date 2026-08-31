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

import type { PartListUnion } from '@google/genai';
import type { Config, SessionListItem } from '@qwen-code/qwen-code-core';
import {
  SlashCommandStatus,
  logSlashCommand,
  makeSlashCommandEvent,
  recordSkillInvocation,
} from '@qwen-code/qwen-code-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { BundledSkillLoader } from '../../services/BundledSkillLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { SavedWorkflowLoader } from '../../services/saved-workflow-loader.js';
import {
  SkillCommandLoader,
  recordAutoSkillCommandUsage,
} from '../../services/SkillCommandLoader.js';
import { CommandService } from '../../services/CommandService.js';
import {
  parseSlashCommand,
  parseStackedSlashCommands,
} from '../commands/commands.js';
import { isSlashCommand } from '../utils/commandUtils.js';
import type { HistoryItemWithoutId } from '../types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { projectSpecialItemText } from './item-projection.js';
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
 * ink submission gate (useGeminiStream): only '/'-prefixed input classified
 * by the shared `isSlashCommand` (which excludes `//`/`/*` comments and
 * file-path-like input) routes here; '?'-prefixed input reaches the
 * model/btw path exactly like ink.
 */
export function isSlashCommandInput(raw: string): boolean {
  return isSlashCommand(raw.trim());
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

/**
 * Neutral effects the OpenTUI backend applies for a dispatched command.
 * `notice` carries projected text for history items the command added via
 * `ui.addItem` alongside a non-handled effect (e.g. /init adds an info
 * notice and returns submit_prompt) — the backend renders it before
 * applying the effect, mirroring ink's item-then-result ordering.
 */
export type SlashEffect =
  | { kind: 'handled' }
  | {
      kind: 'message';
      messageType: 'info' | 'warning' | 'error';
      content: string;
    }
  | { kind: 'help' }
  | {
      kind: 'dialog';
      dialog: string;
      command: string;
      /** /resume <id>: the session to open directly. */
      sessionId?: string;
      /** /resume <title>: pre-filtered sessions for the picker. */
      matchedSessions?: SessionListItem[];
      /** /branch: the name passed through to handleBranch. */
      name?: string;
      /** Model dialogs: which settings file the selection persists to. */
      persistScope?: 'workspace' | 'user';
    }
  | { kind: 'clear' }
  | { kind: 'quit'; notice?: string }
  | {
      kind: 'submit';
      /** The prompt content in full: ink keeps the PartListUnion so image
       * parts (e.g. @{…} file injection) reach the model; `textContent` is
       * the text-only view for consumers that print it. */
      content: PartListUnion;
      textContent: string;
      /** Per-turn model id (ink: /model <id> <prompt> runs on the chosen
       * model without changing the session selection). */
      modelOverride?: string;
      /** Invoked after the agent turn completes successfully (ink: /dream
       * records the manual run this way). */
      onComplete?: () => Promise<void>;
      /** Refresh context-file-backed instructions after this prompt
       * writes them (ink: /remember). */
      refreshContextFilesOnWrite?: boolean;
    };

export type SlashEffectWithNotice = SlashEffect & { notice?: string };

export interface SlashDispatchEnv {
  config: Config | null;
  /**
   * Loaded settings for the command context. The real
   * `CommandContext.services.settings` is non-null (commands/types.ts), so
   * this is required: a null would surface as a generic command failure
   * the first time a command reads `.merged`.
   */
  settings: LoadedSettings;
  abortSignal?: AbortSignal;
  /**
   * Live session stats (start time, metrics, counters) that commands such as
   * /quit and /clear read and persist; the backend owns the true values.
   */
  sessionStats?: SessionStatsState;
  /**
   * Live transcript history commands scan through `context.ui.history`
   * (/doctor's oversized-tool-output check, etc.); absent means empty.
   */
  history?: readonly HistoryItemWithoutId[];
  /**
   * Toggle vim mode and report the new state (commands-context.ts routes
   * the same seam to the host); without it /vim would report a fake
   * "Exited Vim mode." confirmation while toggling nothing.
   */
  toggleVimEnabled?: () => Promise<boolean>;
  /**
   * The backend's session-stats seam for /clear: core rotates the config
   * session id and hands the new id back so the backend can reset its
   * SessionStatsState (start time, counters) instead of leaking pre-clear
   * state across the boundary.
   */
  startNewSession?: (sessionId: string) => void;
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
  env: SlashDispatchEnv,
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
        : {
            kind: 'dialog',
            dialog: result.dialog,
            command: command.name,
            sessionId: result.sessionId,
            matchedSessions: result.matchedSessions,
            name: result.name,
            persistScope: result.persistScope,
          };
    case 'quit': {
      // ink renders QuitActionReturn.messages via QuittingDisplay (the
      // `/quit` echo + session-duration summary); carry the projected text
      // on the effect so the backend can print it during the exit window.
      const notice = projectItems(result.messages, env);
      return notice ? { kind: 'quit', notice } : { kind: 'quit' };
    }
    case 'load_history':
      return result.history.length === 0
        ? { kind: 'clear' }
        : {
            kind: 'message',
            messageType: 'info',
            content: `'/${command.name}' history restore is not yet available in the OpenTUI renderer.`,
          };
    case 'submit_prompt':
      // Carry the full SubmitPromptActionReturn contract: the backend
      // honors modelOverride (/model <id> <prompt>), onComplete (/dream
      // records manual runs), refreshContextFilesOnWrite (/remember), and
      // the PartListUnion content (image parts from @{…} injection) exactly
      // like ink's processor.
      return {
        kind: 'submit',
        content: result.content,
        textContent: stringifyPromptContent(result.content),
        modelOverride: result.modelOverride,
        onComplete: result.onComplete,
        refreshContextFilesOnWrite: result.refreshContextFilesOnWrite,
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
    case 'agent_view_detach':
      return {
        kind: 'message',
        messageType: 'info',
        content: `Agent View detach is not yet available in the OpenTUI renderer.`,
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
): Promise<SlashEffectWithNotice> {
  // ink merges stacked skill invocations (/feat-dev /e2e-testing text);
  // the merge is not ported yet, so report an explicit deferral instead of
  // leaking the second skill token into the first skill's prompt.
  const stacked = parseStackedSlashCommands(raw, commands);
  if (stacked.skills.length >= 2) {
    return {
      kind: 'message',
      messageType: 'info',
      content: `Stacked skill invocations (${stacked.skills
        .map((skill) => `/${skill.name}`)
        .join(
          ' ',
        )}) are not yet available in the OpenTUI renderer. Run each skill separately.`,
    };
  }

  const resolution = resolveSlashCommand(raw, commands);
  if (resolution.type === 'unknown') {
    return {
      kind: 'message',
      messageType: 'error',
      content: `Unknown command: ${resolution.input}`,
    };
  }

  const { command, args } = resolution;

  // Telemetry parity (ink slashCommandProcessor): every executed command
  // logs a SUCCESS/ERROR slash-command event, including parent commands
  // that return early (help listing / bare handled).
  const subcommand =
    resolution.canonicalPath.length > 1
      ? resolution.canonicalPath.slice(1).join(' ')
      : undefined;
  const logEvent = (status: SlashCommandStatus) => {
    if (!env.config) return;
    logSlashCommand(
      env.config,
      makeSlashCommandEvent({
        command: resolution.canonicalPath[0],
        subcommand,
        status,
      }),
    );
  };

  if (!command.action) {
    if (command.subCommands && command.subCommands.length > 0) {
      const helpText = `Command '/${command.name}' requires a subcommand. Available:\n${command.subCommands
        .map((sc) => `  - ${sc.name}: ${sc.description || ''}`)
        .join('\n')}`;
      logEvent(SlashCommandStatus.SUCCESS);
      return { kind: 'message', messageType: 'info', content: helpText };
    }
    logEvent(SlashCommandStatus.SUCCESS);
    return { kind: 'handled' };
  }

  // Skill-specific telemetry: skill invocations feed /stats skills via
  // recordSkillInvocation + recordAutoSkillCommandUsage.
  const isSkillCommand = command.kind === CommandKind.SKILL;
  const skillName = command.skillDetail?.name ?? command.name;
  const recordSkill = (success: boolean) => {
    if (env.config && isSkillCommand) {
      recordSkillInvocation(env.config, { skillName, success });
    }
  };

  let cleared = false;
  const addedItems: HistoryItemWithoutId[] = [];
  const context = {
    executionMode: 'interactive',
    invocation: { raw: raw.trim(), name: command.name, args },
    services: {
      config: env.config,
      settings: env.settings,
      logger: null,
    },
    ui: {
      // Live transcript, not a hardcoded []: /doctor's oversized-tool-output
      // scan (and any other history reader) must see the real session.
      get history() {
        return env.history ? [...env.history] : [];
      },
      addItem: (item: HistoryItemWithoutId) => {
        addedItems.push(item);
        return 0;
      },
      clear: () => {
        cleared = true;
      },
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
      toggleVimEnabled: () =>
        env.toggleVimEnabled?.() ?? Promise.resolve(false),
      setMemoryFileCount: () => {},
      reloadCommands: () => {},
      setSessionName: () => {},
      extensionsUpdateState: new Map(),
      dispatchExtensionStateUpdate: () => {},
      addConfirmUpdateExtensionRequest: () => {},
    },
    session: {
      // Commands such as /quit read session timing stats and /clear persists
      // them; supply the backend's real stats when available. Absent stats
      // get a start time of now: an epoch fabrication would stamp ~57-year
      // durations into the persisted usage history (clearCommand's
      // ?? new Date() guard passes a non-nullish epoch straight through).
      stats: env.sessionStats ?? {
        sessionId: '',
        sessionStartTime: new Date(),
        metrics: {},
        lastPromptTokenCount: 0,
        promptCount: 0,
      },
      // /clear calls config.startNewSession() and checks this seam to
      // hand the new session id to the backend's SessionStatsState; without
      // it the reset is silently skipped (commands-context.ts wires the
      // same seam to the host).
      startNewSession: env.startNewSession
        ? (sessionId: string) => env.startNewSession!(sessionId)
        : undefined,
      sessionShellAllowlist: new Set<string>(),
    },
    abortSignal: env.abortSignal,
  } as unknown as CommandContext;

  try {
    // ink races the action against the abort signal so ESC cancels
    // non-cooperative commands (e.g. /compress, whose tryCompressChat takes
    // no AbortSignal) instead of blocking until they settle.
    let result: SlashCommandActionReturn | void;
    if (env.abortSignal) {
      const signal = env.abortSignal;
      if (signal.aborted) {
        // Already aborted: skip the action entirely — its side effects
        // (clear, persist, addItem) must not run on a cancelled submission.
        result = undefined;
      } else {
        const aborted = new Promise<undefined>((resolve) => {
          signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          });
        });
        result = await Promise.race([command.action(context, args), aborted]);
      }
    } else {
      result = await command.action(context, args);
    }
    // ink discards command results once the submission is aborted.
    if (env.abortSignal?.aborted) {
      return { kind: 'handled' };
    }
    recordSkill(true);
    if (isSkillCommand && env.config) {
      void recordAutoSkillCommandUsage(env.config, command);
    }
    logEvent(SlashCommandStatus.SUCCESS);
    if (cleared) {
      return { kind: 'clear' };
    }
    const effect = mapActionResult(result, command, env);
    if (addedItems.length > 0) {
      const notice = projectAddedItems(addedItems, env);
      if (effect.kind === 'handled') {
        return { kind: 'message', messageType: 'info', content: notice };
      }
      return { ...effect, notice };
    }
    return effect;
  } catch (error) {
    // ink's mirrored catch checks the signal first: an ESC-cancelled
    // command (the action rejects with AbortError) is the user's own
    // cancellation, not a failure — no error telemetry, no error message.
    if (env.abortSignal?.aborted) {
      return { kind: 'handled' };
    }
    recordSkill(false);
    logEvent(SlashCommandStatus.ERROR);
    return {
      kind: 'message',
      messageType: 'error',
      content: `Command '/${command.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Projects history items to transcript text (ui.addItem payloads, quit
 * messages, …); null when none of them has a projection.
 */
function projectItems(
  items: readonly HistoryItemWithoutId[],
  env: SlashDispatchEnv,
): string | null {
  const texts = items
    .map((item) =>
      projectSpecialItemText(item, {
        config: env.config,
        stats: env.sessionStats,
        // model-pricing (R1-92) resolves through settings.merged.modelPricing
        settings: env.settings,
      }),
    )
    .filter((text): text is string => Boolean(text));
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * Projects history items a command added via `ui.addItem` (e.g. `/stats
 * model`) to transcript text; falls back to an explicit parity deferral
 * when no projection exists.
 */
function projectAddedItems(
  items: HistoryItemWithoutId[],
  env: SlashDispatchEnv,
): string {
  return (
    projectItems(items, env) ??
    'This command renders a history item, which is not yet available in the OpenTUI renderer.'
  );
}
