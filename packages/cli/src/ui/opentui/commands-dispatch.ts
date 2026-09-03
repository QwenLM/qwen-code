/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-parity slash-command dispatch for the OpenTUI renderer (PR1 slice 5).
 *
 * `OpenTuiSlashDispatcher.handle` reproduces the ink
 * `useSlashCommandProcessor.handleSlashCommand` pipeline end to end against
 * the OpenTUI backend (`OpenTuiCommandHost`):
 *
 *  - the same guards ('/' or '?' prefix, no path-like input)
 *  - the same invocation echo item (skipped for /btw)
 *  - stacked skill handling (`/a /b prompt` merged into one submit)
 *  - ESC cancellation via an AbortController raced against the action
 *  - identical result mapping for every `SlashCommandActionReturn` kind:
 *    messages, all dialogs (routed by commands-registry.ts), quit, tool
 *    scheduling, load_history, submit_prompt (with user-prompt-expansion
 *    hooks), goal_control render rules, and both confirmation flows with
 *    their recursive re-invocation
 *  - identical telemetry (logSlashCommand) and chat-recording behavior,
 *    including the skip list and the recording-aware addItem wrapper
 *
 * The result is a neutral `OpenTuiDispatchOutcome` the OpenTUI backend
 * applies, where ink returned `SlashCommandProcessorResult` to AppContainer.
 */

import type { PartListUnion } from '@google/genai';
import {
  createDebugLogger,
  logSlashCommand,
  makeSlashCommandEvent,
  recordSkillInvocation,
  SlashCommandStatus,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import {
  MessageType,
  type HistoryItem,
  type HistoryItemWithoutId,
  type Message,
} from '../types.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from '../commands/types.js';
import {
  MAX_STACKED_SKILLS,
  parseSlashCommand,
  parseStackedSlashCommands,
} from '../commands/commands.js';
import {
  hasSlashCommandPathSeparator,
  isBtwCommand,
} from '../utils/commandUtils.js';
import { recordAutoSkillCommandUsage } from '../../services/SkillCommandLoader.js';
import {
  ExtensionRefreshState,
  EXTENSION_RELOAD_FAILED_REASON,
} from '../../config/extension-refresh-state.js';
import { AppEvent } from '../../utils/events.js';
import { refreshExtensionContentRuntime } from '../../config/extension-runtime-reload.js';
import { isPickerOnlyModelInvocation } from '../commands/modelCommand.js';
import {
  appendUserPromptExpansionAdditionalContext,
  formatUserPromptExpansionBlockedMessage,
  serializeUserPromptExpansionPrompt,
} from '../../utils/userPromptExpansionHook.js';
import type { RecentSlashCommand } from '../hooks/useSlashCompletion.js';
import { loadInteractiveCommands } from './slash-dispatch.js';
import {
  createOpenTuiCommandContext,
  type OpenTuiCommandHost,
  type OpenTuiCommandServices,
} from './commands-context.js';
import {
  routeDialogToOpenTui,
  type OpenTuiDialogRequest,
} from './commands-registry.js';
import {
  commandMessageItem,
  messageToHistoryItem,
  serializeHistoryItemForRecording,
  SLASH_COMMANDS_SKIP_RECORDING,
} from './commands-output.js';

const debugLogger = createDebugLogger('OPENTUI_SLASH_DISPATCH');

/**
 * Parity of the same-named sets and helper in slashCommandProcessor.ts:
 * commands whose bare invocation just opens a dialog (rather than
 * performing work) keep their echo out of the transcript.
 */
const SLASH_COMMAND_ROOTS_HIDE_INVOCATION = new Set([
  'auth',
  'diff',
  'editor',
  'help',
  'settings',
  'status',
  'stats',
  'theme',
]);
const BARE_SLASH_COMMANDS_HIDE_INVOCATION = new Set([
  'effort',
  'model',
  'output-style',
  'statusline',
]);

export function shouldHideSlashCommandInvocation(
  command: SlashCommand | undefined,
  canonicalPath: string[],
  args: string,
): boolean {
  if (command?.kind !== CommandKind.BUILT_IN) {
    return false;
  }

  // Bare-root match only: subcommands that produce output (e.g. `/status
  // paths`) keep their invocation like any other work-performing command.
  if (
    canonicalPath.length === 1 &&
    SLASH_COMMAND_ROOTS_HIDE_INVOCATION.has(canonicalPath[0] ?? '')
  ) {
    // NO_COLOR prevents the theme dialog from opening, so /theme prints
    // feedback instead and keeps its invocation like any work-performing
    // command.
    if (canonicalPath[0] === 'theme' && process.env['NO_COLOR']) {
      return false;
    }
    return true;
  }

  const path = canonicalPath.join(' ');
  if (BARE_SLASH_COMMANDS_HIDE_INVOCATION.has(path)) {
    if (path === 'model') {
      return isPickerOnlyModelInvocation(args);
    }
    return args.trim() === '';
  }

  return false;
}

/** Neutral outcome the OpenTUI backend applies (ink: SlashCommandProcessorResult + dialog actions). */
export type OpenTuiDispatchOutcome =
  | { kind: 'handled' }
  | {
      kind: 'schedule_tool';
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  | {
      kind: 'submit_prompt';
      content: PartListUnion;
      onComplete?: () => Promise<void>;
      modelOverride?: string;
      /** ink parity: refresh memory when the turn writes a context file. */
      refreshContextFilesOnWrite?: boolean;
    }
  | { kind: 'quit'; messages: HistoryItem[] }
  | { kind: 'open_dialog'; request: OpenTuiDialogRequest };

interface RunOptions {
  oneTimeShellAllowlist?: Set<string>;
  overwriteConfirmed?: boolean;
  existingInvocationItemId?: number;
}

/**
 * Parity of `hasUserPromptExpansionHooks` in slashCommandProcessor.ts.
 */
function hasUserPromptExpansionHooks(
  services: OpenTuiCommandServices,
): boolean {
  const config = services.config;
  return (
    !!config &&
    !config.getDisableAllHooks?.() &&
    (config.hasHooksForEvent?.('UserPromptExpansion') ?? false)
  );
}

const MAX_EXTENSION_CONTENT_REFRESH_PASSES = 5;
// How long the dispatch retry waits for the skill manager (created inside
// config.initialize()) before reloading the registry. Bounded so a config
// that never finishes initializing degrades to the "Unknown command"
// message instead of a stuck prompt.
const STARTUP_REGISTRY_WAIT_MS = 15_000;
const STARTUP_REGISTRY_POLL_MS = 100;

export class OpenTuiSlashDispatcher {
  private activeAbortController: AbortController | null = null;
  private recentCommands = new Map<string, RecentSlashCommand>();
  private readonly extensionRefreshState: ExtensionRefreshState;
  private readonly extensionRefreshListeners: Array<() => void> = [];
  private extensionContentRefreshTimer: ReturnType<typeof setTimeout> | null =
    null;
  private extensionContentRefreshRunning = false;
  private extensionContentRefreshPending = false;
  private startupRetryUsed = false;

  constructor(
    private readonly host: OpenTuiCommandHost,
    private readonly services: OpenTuiCommandServices,
    private commandList: readonly SlashCommand[],
  ) {
    // ink parity: the slash processor subscribes to the shared
    // ExtensionRefreshState (created once in gemini.tsx and also driving the
    // extension file watcher) so /reload-plugins and disk-driven reload
    // notices reach this renderer too. Without the shared instance every
    // dispatch would build a fresh fallback no watcher ever sees.
    this.extensionRefreshState =
      services.extensionRefreshState ?? new ExtensionRefreshState();
    this.subscribeToExtensionRefresh();
  }

  private subscribeToExtensionRefresh(): void {
    const refreshNeededListener = (reason?: unknown) => {
      this.host.addItem(
        {
          type: MessageType.INFO,
          text:
            reason === EXTENSION_RELOAD_FAILED_REASON
              ? 'Extension reload did not complete. Run /reload-plugins to try again.'
              : 'Extensions changed on disk. Run /reload-plugins to apply updates.',
        },
        Date.now(),
      );
    };
    this.extensionRefreshState.on(
      AppEvent.ExtensionRefreshNeeded,
      refreshNeededListener,
    );
    this.extensionRefreshListeners.push(() => {
      this.extensionRefreshState.off(
        AppEvent.ExtensionRefreshNeeded,
        refreshNeededListener,
      );
    });

    // ink's processor debounce ExtensionContentChanged by 250ms and then
    // re-runs the runtime refresh (command registry + extension content).
    const contentChangedListener = () => {
      if (this.extensionContentRefreshTimer) {
        clearTimeout(this.extensionContentRefreshTimer);
      }
      this.extensionContentRefreshTimer = setTimeout(() => {
        this.extensionContentRefreshTimer = null;
        void this.runExtensionContentRefresh();
      }, 250);
    };
    this.extensionRefreshState.on(
      AppEvent.ExtensionContentChanged,
      contentChangedListener,
    );
    this.extensionRefreshListeners.push(() => {
      this.extensionRefreshState.off(
        AppEvent.ExtensionContentChanged,
        contentChangedListener,
      );
    });
  }

  private async runExtensionContentRefresh(): Promise<void> {
    const config = this.services.config;
    if (!config) return;
    if (this.extensionContentRefreshRunning) {
      this.extensionContentRefreshPending = true;
      return;
    }
    this.extensionContentRefreshRunning = true;
    let refreshPasses = 0;
    try {
      do {
        if (refreshPasses >= MAX_EXTENSION_CONTENT_REFRESH_PASSES) {
          this.extensionContentRefreshPending = false;
          this.host.addItem(
            {
              type: MessageType.ERROR,
              text: 'Failed to refresh extension content: too many extension content changes are still pending. Run /reload-plugins to apply updates.',
            },
            Date.now(),
          );
          return;
        }
        refreshPasses++;
        this.extensionContentRefreshPending = false;
        if (this.extensionRefreshState.isReloadInProgress()) return;
        if (this.extensionRefreshState.needsExtensionRefresh()) return;
        await refreshExtensionContentRuntime({
          config,
          reloadCommands: () => this.loadCommands(),
        });
      } while (this.extensionContentRefreshPending);
    } catch {
      this.extensionContentRefreshPending = false;
      this.host.addItem(
        {
          type: MessageType.ERROR,
          text: 'Failed to refresh extension content. Run /reload-plugins to apply updates.',
        },
        Date.now(),
      );
    } finally {
      this.extensionContentRefreshRunning = false;
    }
  }

  /** Detaches the extension-refresh subscriptions (backend unmount). */
  dispose(): void {
    for (const off of this.extensionRefreshListeners) off();
    this.extensionRefreshListeners.length = 0;
    if (this.extensionContentRefreshTimer) {
      clearTimeout(this.extensionContentRefreshTimer);
      this.extensionContentRefreshTimer = null;
    }
  }

  get commands(): readonly SlashCommand[] {
    return this.commandList;
  }

  /** Parity of the processor's `reloadCommands` result swap. */
  setCommands(commands: readonly SlashCommand[]): void {
    this.commandList = commands;
  }

  /** Rebuilds the registry through the original loader stack. */
  async loadCommands(signal?: AbortSignal): Promise<void> {
    this.commandList = await loadInteractiveCommands(
      this.services.config,
      signal,
      this.services.settings,
    );
  }

  /**
   * Startup-window self-heal: the first dispatcher can attach a registry
   * built while config.initialize() was still in flight — the second
   * initialize() call throws "already initialized", the catch proceeds, and
   * the skill loaders run before the skill manager exists, so builtin
   * commands resolve but every skill (e.g. /qc-helper) reports "Unknown
   * command" until the config-ready dispatcher replaces this one. One
   * bounded retry per dispatcher lifetime: wait for the skill manager, then
   * reload the registry so the re-parse sees the complete list.
   */
  private async ensureCommandsLoaded(): Promise<boolean> {
    if (this.startupRetryUsed || !this.services.config) {
      return false;
    }
    this.startupRetryUsed = true;
    const config = this.services.config;
    const deadline = Date.now() + STARTUP_REGISTRY_WAIT_MS;
    while (!config.getSkillManager?.() && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, STARTUP_REGISTRY_POLL_MS),
      );
    }
    try {
      await this.loadCommands();
    } catch {
      // Keep the current registry; the caller re-parses and reports
      // "Unknown command" if the command really doesn't exist.
    }
    return true;
  }

  /** Parity of `recentSlashCommands` (hidden commands are not tracked). */
  get recentCommandList(): ReadonlyMap<string, RecentSlashCommand> {
    return this.recentCommands;
  }

  /**
   * Mid-turn admission (ink AppContainer.handleFinalSubmit): while a model
   * turn responds, a slash submission runs immediately only when its command
   * opted into `canRunDuringStreaming`; everything else the dispatcher would
   * take waits for idle. False for input `handle()` hands back to the model
   * (a `/`-prefixed path) and for btw side-questions (`/btw`, `?btw`), which
   * ink submits mid-turn as steering rather than queueing.
   *
   * Quit is exempt ahead of the opt-in check: ink runs its quit family before
   * the queue precisely so an exit can stop an active stream instead of
   * waiting for it to end.
   */
  mustDeferDuringStreaming(rawQuery: string): boolean {
    const trimmed = rawQuery.trim();
    if (!this.takesAsSlashCommand(trimmed) || isBtwCommand(trimmed)) {
      return false;
    }
    const { commandToExecute } = parseSlashCommand(trimmed, this.commandList);
    // Matched on the resolved command, so `/exit` is covered as an altName.
    if (commandToExecute?.name === 'quit') return false;
    return commandToExecute?.canRunDuringStreaming !== true;
  }

  /** Whether {@link handle} processes this input instead of handing it back. */
  private takesAsSlashCommand(trimmed: string): boolean {
    if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
      return false;
    }
    return !(trimmed.startsWith('/') && hasSlashCommandPathSeparator(trimmed));
  }

  /**
   * Parity of `cancelSlashCommand` in slashCommandProcessor.ts: ESC while a
   * slash command runs aborts it and reports the cancellation.
   */
  cancel(): void {
    this.host.cancelBtw();
    if (!this.activeAbortController) {
      return;
    }
    this.activeAbortController.abort();
    this.host.addItem(
      { type: MessageType.INFO, text: 'Command cancelled.' },
      Date.now(),
    );
    this.host.setPendingItem(null);
    this.host.setIsProcessing(false);
  }

  /**
   * Entry point — parity of the top of `handleSlashCommand`: returns `false`
   * when the input is not a slash command at all.
   */
  async handle(rawQuery: string): Promise<OpenTuiDispatchOutcome | false> {
    const trimmed = rawQuery.trim();
    if (!this.takesAsSlashCommand(trimmed)) {
      return false;
    }
    return this.run(trimmed, {});
  }

  private addMessage(message: Message): void {
    this.host.addItem(
      messageToHistoryItem(message),
      message.timestamp.getTime(),
    );
  }

  private async run(
    trimmed: string,
    options: RunOptions,
  ): Promise<OpenTuiDispatchOutcome> {
    const recordedItems: HistoryItemWithoutId[] = [];
    const addItemWithRecording = (
      item: HistoryItemWithoutId,
      timestamp: number,
    ): number => {
      recordedItems.push(item);
      return this.host.addItem(item, timestamp);
    };

    this.host.setIsProcessing(true);
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const userMessageTimestamp = Date.now();
    let invocationItemId = options.existingInvocationItemId;
    let invocationSentToModel = false;
    let {
      commandToExecute,
      args,
      canonicalPath: resolvedCommandPath,
    } = parseSlashCommand(trimmed, this.commandList);
    if (!commandToExecute && (await this.ensureCommandsLoaded())) {
      ({
        commandToExecute,
        args,
        canonicalPath: resolvedCommandPath,
      } = parseSlashCommand(trimmed, this.commandList));
    }
    let hideInvocation =
      isBtwCommand(trimmed) ||
      shouldHideSlashCommandInvocation(
        commandToExecute,
        resolvedCommandPath,
        args,
      );
    if (!hideInvocation && invocationItemId === undefined) {
      invocationItemId = addItemWithRecording(
        { type: MessageType.USER, text: trimmed, sentToModel: false },
        userMessageTimestamp,
      );
    }

    // ink parity: a picker-shaped command that rejects its arguments before
    // opening a dialog (e.g. `/model` with bad args) still owes the user the
    // invocation echo — otherwise the error message floats context-less.
    const revealHiddenInvocation = () => {
      if (
        resolvedCommandPath.join(' ') !== 'model' ||
        !hideInvocation ||
        invocationItemId !== undefined
      ) {
        return;
      }
      hideInvocation = false;
      invocationItemId = addItemWithRecording(
        { type: MessageType.USER, text: trimmed, sentToModel: false },
        userMessageTimestamp,
      );
    };

    let hasError = false;
    let delegatedToRecursiveInvocation = false;

    const subcommand =
      resolvedCommandPath.length > 1
        ? resolvedCommandPath.slice(1).join(' ')
        : undefined;
    const isSkillCommand = commandToExecute?.kind === CommandKind.SKILL;
    let skillInvocationRecorded = false;
    const recordSkillCommandInvocation = (success: boolean) => {
      const config = this.services.config;
      if (
        !config ||
        !commandToExecute ||
        !isSkillCommand ||
        skillInvocationRecorded
      ) {
        return;
      }
      recordSkillInvocation(config, {
        skillName: commandToExecute.skillDetail?.name ?? commandToExecute.name,
        success,
      });
      skillInvocationRecorded = true;
    };

    try {
      const stackedResult = parseStackedSlashCommands(
        trimmed,
        this.commandList,
      );
      if (stackedResult.skills.length >= 2) {
        const combinedContent: PartListUnion[] = [];
        let firstModelOverride: string | undefined;
        const onCompleteCallbacks: Array<() => Promise<void>> = [];
        let refreshContextFilesOnWrite = false;

        for (const skill of stackedResult.skills) {
          if (!skill.action) continue;
          const skillContext: CommandContext = {
            invocation: {
              raw: `/${skill.name}`,
              name: skill.name,
              args: '',
            },
            services: {
              config: this.services.config,
              settings: this.services.settings,
              logger: null,
            },
          } as unknown as CommandContext;

          const skillResult = await skill.action(skillContext, '');
          if (skillResult?.type === 'submit_prompt') {
            combinedContent.push(skillResult.content);
            firstModelOverride ??= skillResult.modelOverride;
            refreshContextFilesOnWrite ||= Boolean(
              skillResult.refreshContextFilesOnWrite,
            );
            if (skillResult.onComplete) {
              onCompleteCallbacks.push(skillResult.onComplete);
            }
          } else if (
            skillResult?.type === 'message' &&
            skillResult.messageType === 'error'
          ) {
            this.addMessage({
              type: MessageType.ERROR,
              content: `Skill "/${skill.name}" error: ${skillResult.content}`,
              timestamp: new Date(),
            });
          }

          if (this.services.config) {
            const succeeded = skillResult?.type === 'submit_prompt';
            recordSkillInvocation(this.services.config, {
              skillName: skill.skillDetail?.name ?? skill.name,
              success: succeeded,
            });
            if (succeeded) {
              void recordAutoSkillCommandUsage(this.services.config, skill);
            }
          }
        }

        if (stackedResult.remainingText) {
          combinedContent.push([{ text: stackedResult.remainingText }]);
        }

        if (stackedResult.exceededMax) {
          this.addMessage({
            type: MessageType.WARNING,
            content: `Only the first ${MAX_STACKED_SKILLS} skills were loaded. Additional /skill tokens were treated as prompt text.`,
            timestamp: new Date(),
          });
        }

        invocationSentToModel = true;
        if (invocationItemId !== undefined) {
          this.host.updateItem(invocationItemId, { sentToModel: true });
        }

        const mergedContent: PartListUnion = combinedContent.flat();
        return {
          kind: 'submit_prompt',
          content: mergedContent,
          ...(firstModelOverride ? { modelOverride: firstModelOverride } : {}),
          ...(refreshContextFilesOnWrite
            ? { refreshContextFilesOnWrite: true }
            : {}),
          ...(onCompleteCallbacks.length
            ? {
                onComplete: async () => {
                  for (const cb of onCompleteCallbacks) await cb();
                },
              }
            : {}),
        };
      }

      if (commandToExecute) {
        if (!commandToExecute.hidden) {
          const existing = this.recentCommands.get(commandToExecute.name);
          this.recentCommands.set(commandToExecute.name, {
            name: commandToExecute.name,
            usedAt: Date.now(),
            count: (existing?.count ?? 0) + 1,
          });
        }

        if (commandToExecute.action) {
          const baseContext = createOpenTuiCommandContext(
            this.host,
            this.services,
          );
          const fullCommandContext: CommandContext = {
            ...baseContext,
            ui: {
              ...baseContext.ui,
              addItem: (item, timestamp) =>
                addItemWithRecording(item, timestamp),
            },
            invocation: {
              raw: trimmed,
              name: commandToExecute.name,
              args,
            },
            overwriteConfirmed: options.overwriteConfirmed,
            abortSignal: abortController.signal,
          };

          // Parity: a "Proceed" confirmation temporarily augments the session
          // allowlist for this single execution only.
          const sessionShellAllowlist =
            options.oneTimeShellAllowlist &&
            options.oneTimeShellAllowlist.size > 0
              ? new Set([
                  ...fullCommandContext.session.sessionShellAllowlist,
                  ...options.oneTimeShellAllowlist,
                ])
              : fullCommandContext.session.sessionShellAllowlist;
          fullCommandContext.session = {
            ...fullCommandContext.session,
            sessionShellAllowlist,
          };

          const abortPromise = new Promise<undefined>((resolve) => {
            abortController.signal.addEventListener(
              'abort',
              () => resolve(undefined),
              { once: true },
            );
          });
          // A pre-aborted signal must skip the action entirely: an 'abort'
          // listener registered after the signal already aborted never
          // fires, so the race would otherwise await the action's side
          // effects (session rotation, telemetry reset) before discarding.
          const result = abortController.signal.aborted
            ? undefined
            : await Promise.race([
                commandToExecute.action(fullCommandContext, args),
                abortPromise,
              ]);

          if (abortController.signal.aborted) {
            return { kind: 'handled' };
          }

          if (result) {
            switch (result.type) {
              case 'tool':
                return {
                  kind: 'schedule_tool',
                  toolName: result.toolName,
                  toolArgs: result.toolArgs,
                };
              case 'message': {
                let messageContent = result.content;
                // The OpenTUI renderer has no vim key mode; the toggle host
                // reports the real (off) state, and the ink command would
                // render that as "Exited Vim mode." — actively misleading.
                // Replace it with the faithful notice (audit 01 G-11b).
                if (commandToExecute.name === 'vim') {
                  messageContent =
                    'Vim mode is not yet available in the OpenTUI renderer.';
                }
                // Picker-shaped commands can still reject their arguments
                // before opening a dialog. Keep those failures paired with
                // the invocation in both live and reconstructed history, and
                // route the message through addItemWithRecording so the
                // chat-recording output phase sees it (ink parity).
                revealHiddenInvocation();
                const messageType =
                  result.messageType === 'info'
                    ? MessageType.INFO
                    : result.messageType === 'warning'
                      ? MessageType.WARNING
                      : MessageType.ERROR;
                addItemWithRecording(
                  { type: messageType, text: messageContent },
                  Date.now(),
                );
                return { kind: 'handled' };
              }
              case 'goal_control': {
                const rendersHere =
                  result.cause === undefined || this.host.isIdle();
                if (rendersHere) {
                  const snapshot = result.response.snapshot;
                  if (snapshot.goal || result.cause === 'clear') {
                    this.host.addItem(
                      {
                        type: MessageType.GOAL_STATE,
                        snapshot,
                        ...(result.cause ? { cause: result.cause } : {}),
                      },
                      Date.now(),
                    );
                  } else {
                    this.addMessage({
                      type: MessageType.INFO,
                      content: 'No Goal set.',
                      timestamp: new Date(),
                    });
                  }
                }
                return { kind: 'handled' };
              }
              case 'agent_view_detach':
                this.addMessage({
                  type: MessageType.INFO,
                  content:
                    'Agent View detach is not yet available in the OpenTUI renderer.',
                  timestamp: new Date(),
                });
                return { kind: 'handled' };
              case 'dialog': {
                if (result.dialog === 'resume') {
                  if (result.sessionId) {
                    await this.host.handleResume(result.sessionId);
                    return { kind: 'handled' };
                  }
                }
                if (result.dialog === 'branch') {
                  await this.host.handleBranch(result.name);
                  return { kind: 'handled' };
                }
                return {
                  kind: 'open_dialog',
                  request: routeDialogToOpenTui(result),
                };
              }
              case 'load_history': {
                this.services.config
                  ?.getGeminiClient()
                  ?.setHistory(result.clientHistory);
                fullCommandContext.ui.clear();
                const now = Date.now();
                result.history.forEach((item, index) => {
                  fullCommandContext.ui.addItem(item, now + index);
                });
                return { kind: 'handled' };
              }
              case 'quit':
                return { kind: 'quit', messages: result.messages };
              case 'submit_prompt': {
                const invocation = fullCommandContext.invocation;
                let content = result.content;
                const output = hasUserPromptExpansionHooks(this.services)
                  ? await this.services.config
                      ?.getHookSystem()
                      ?.fireUserPromptExpansionEvent(
                        invocation?.name ?? '',
                        invocation?.args ?? '',
                        serializeUserPromptExpansionPrompt(content),
                        abortController.signal,
                      )
                  : undefined;
                if (abortController.signal.aborted) {
                  hasError = true;
                  return { kind: 'handled' };
                }
                if (output) {
                  const blockingError = output.getBlockingError();
                  if (blockingError.blocked || output.shouldStopExecution()) {
                    hasError = true;
                    recordSkillCommandInvocation(false);
                    this.addMessage({
                      type: MessageType.ERROR,
                      content: formatUserPromptExpansionBlockedMessage(
                        blockingError.reason || output.getEffectiveReason(),
                      ),
                      timestamp: new Date(),
                    });
                    return { kind: 'handled' };
                  }
                  content = appendUserPromptExpansionAdditionalContext(
                    content,
                    output.getAdditionalContext(),
                  );
                }
                if (invocationItemId !== undefined) {
                  invocationSentToModel = true;
                  this.host.updateItem(invocationItemId, { sentToModel: true });
                }
                recordSkillCommandInvocation(true);
                void recordAutoSkillCommandUsage(
                  this.services.config,
                  commandToExecute,
                );
                return {
                  kind: 'submit_prompt',
                  content,
                  ...(result.onComplete
                    ? { onComplete: result.onComplete }
                    : {}),
                  ...(result.modelOverride
                    ? { modelOverride: result.modelOverride }
                    : {}),
                  ...(result.refreshContextFilesOnWrite
                    ? { refreshContextFilesOnWrite: true }
                    : {}),
                };
              }
              case 'confirm_shell_commands': {
                const { outcome, approvedCommands } =
                  await this.host.presentShellConfirmation(
                    result.commandsToConfirm,
                  );

                if (
                  outcome === ToolConfirmationOutcome.Cancel ||
                  !approvedCommands ||
                  approvedCommands.length === 0
                ) {
                  return { kind: 'handled' };
                }

                if (outcome === ToolConfirmationOutcome.ProceedAlways) {
                  this.host.addSessionShellAllowlist(approvedCommands);
                }

                delegatedToRecursiveInvocation = true;
                return await this.run(result.originalInvocation.raw, {
                  // Approved commands are a one-time grant for this execution.
                  oneTimeShellAllowlist: new Set(approvedCommands),
                  existingInvocationItemId: invocationItemId,
                });
              }
              case 'confirm_action': {
                const confirmed = await this.host.presentActionConfirmation(
                  result.prompt,
                );

                if (!confirmed) {
                  addItemWithRecording(
                    commandMessageItem('info', 'Operation cancelled.'),
                    Date.now(),
                  );
                  return { kind: 'handled' };
                }

                delegatedToRecursiveInvocation = true;
                return await this.run(result.originalInvocation.raw, {
                  overwriteConfirmed: true,
                  existingInvocationItemId: invocationItemId,
                });
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
                throw new Error(`Unhandled slash command result: ${unhandled}`);
              }
            }
          }

          return { kind: 'handled' };
        } else if (commandToExecute.subCommands) {
          const helpText = `Command '/${commandToExecute.name}' requires a subcommand. Available:\n${commandToExecute.subCommands
            .map((sc) => `  - ${sc.name}: ${sc.description || ''}`)
            .join('\n')}`;
          this.addMessage({
            type: MessageType.INFO,
            content: helpText,
            timestamp: new Date(),
          });
          return { kind: 'handled' };
        }
      }

      this.addMessage({
        type: MessageType.ERROR,
        content: `Unknown command: ${trimmed}`,
        timestamp: new Date(),
      });

      return { kind: 'handled' };
    } catch (e: unknown) {
      // If cancelled via ESC, `cancel` already handled cleanup
      if (abortController.signal.aborted) {
        return { kind: 'handled' };
      }
      hasError = true;
      recordSkillCommandInvocation(false);
      if (this.services.config) {
        const event = makeSlashCommandEvent({
          command: resolvedCommandPath[0],
          subcommand,
          status: SlashCommandStatus.ERROR,
        });
        logSlashCommand(this.services.config, event);
      }
      addItemWithRecording(
        {
          type: MessageType.ERROR,
          text: e instanceof Error ? e.message : String(e),
        },
        Date.now(),
      );
      return { kind: 'handled' };
    } finally {
      const chatRecordingService =
        this.services.config?.getChatRecordingService?.();
      const primaryCommand =
        resolvedCommandPath[0] ||
        trimmed.replace(/^[/?]/, '').split(/\s+/u)[0] ||
        trimmed;
      // The built-in /advisor is skipped by identity (kind + name) so a
      // user-defined command shadowing the name is still recorded like
      // any other custom command (ink parity).
      const isBuiltInAdvisor =
        primaryCommand === 'advisor' &&
        commandToExecute?.kind === CommandKind.BUILT_IN;
      const shouldRecord =
        !delegatedToRecursiveInvocation &&
        !isBuiltInAdvisor &&
        !SLASH_COMMANDS_SKIP_RECORDING.has(primaryCommand);
      try {
        if (shouldRecord) {
          chatRecordingService?.recordSlashCommand({
            phase: 'invocation',
            rawCommand: trimmed,
            sentToModel: invocationSentToModel,
            hiddenInvocation: hideInvocation,
          });
          const outputItems = recordedItems
            .filter((item) => item.type !== 'user')
            .map(serializeHistoryItemForRecording);
          chatRecordingService?.recordSlashCommand({
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
      if (
        this.services.config &&
        resolvedCommandPath[0] &&
        !hasError &&
        !delegatedToRecursiveInvocation
      ) {
        const event = makeSlashCommandEvent({
          command: resolvedCommandPath[0],
          subcommand,
          status: SlashCommandStatus.SUCCESS,
        });
        logSlashCommand(this.services.config, event);
      }
      this.host.setIsProcessing(false);
    }
  }
}

/**
 * Convenience: loads the interactive registry through the original loader
 * stack (same as the ink processor) and returns a ready dispatcher.
 */
export async function createOpenTuiSlashDispatcher(
  host: OpenTuiCommandHost,
  services: OpenTuiCommandServices,
  signal?: AbortSignal,
): Promise<OpenTuiSlashDispatcher> {
  const commands = await loadInteractiveCommands(
    services.config,
    signal,
    services.settings,
  );
  return new OpenTuiSlashDispatcher(host, services, commands);
}
