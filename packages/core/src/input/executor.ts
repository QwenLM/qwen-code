/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Batch command executor.
 *
 * `executeUserInput()` orchestrates the execution of one or more `QueuedCommand`
 * entries through `processUserInput()`, then triggers the API call via `onQuery`.
 *
 * Key invariants:
 *   - Only the **first** command in a batch carries `pastedContents`.
 *   - The 2nd+ commands set `skipAttachments: true` to avoid duplicate injection.
 *   - `origin` from `task-notification` commands is stamped onto resulting `UserMessage`s.
 *   - If `shouldQuery` is `false` for the first command (local command), no API call is made.
 */

import type {
  Message,
  UserMessage,
} from '../protocol/transcript/message.js';
import type {
  MessageOrigin,
  QueuedCommand,
  ProcessInputResult,
} from './types.js';
import type { ProcessInputFullContext } from './processor.js';
import { processUserInput } from './processor.js';
import { noteHumanTurn } from '../messaging/outbound-tracking.js';
import { snapshotAttachmentDeltaState } from '../attachments/transcript-state.js';
import { emitInputPromptReceived } from '../utils/diagnosticInterceptors.js';
import { extractTextFromBlocks } from '../utils/promptTextUtils.js';
import {
  wrapTextByOrigin,
  deriveOrigin,
} from './origin-content-wrapping.js';
import {
  isToolResultUserMessage,
  parseBashInputPromptText,
} from '../protocol/transcript/message-utils.js';
import { SelectedSkillActivationError } from '../skills/selectedSkillActivation.js';

function coalesceFreshPeerCommands(
  commands: readonly QueuedCommand[],
): QueuedCommand[] {
  const coalesced: QueuedCommand[] = [];
  const isMailboxFrame = (command: QueuedCommand) =>
    command.origin?.kind === 'peer' &&
    typeof command.prompt === 'string' &&
    command.prompt.startsWith('<teammate-message ');

  for (const command of commands) {
    const previous = coalesced.at(-1);
    if (
      previous &&
      isMailboxFrame(previous) &&
      isMailboxFrame(command) &&
      previous.commandMode === command.commandMode &&
      typeof previous.prompt === 'string' &&
      typeof command.prompt === 'string'
    ) {
      previous.prompt = `${previous.prompt}\n\n${command.prompt}`;
      continue;
    }
    coalesced.push({ ...command });
  }

  return coalesced;
}

export interface ExecuteInputResult {
  messages: Message[];
  shouldQuery: boolean;
  commandInvocationId?: string;
  allowedTools?: string[];
  model?: string;
  effort?: string;
  resultText?: string;
  resultIsError?: boolean;
  terminalReason?: string;
  errorCode?: number | string;
  hookStop?: { stopReason?: string };
  nextInput?: string;
  submitNextInput?: boolean;
}

// ---------------------------------------------------------------------------
// ExecuteInputContext — extends ProcessInputContext with query callback
// ---------------------------------------------------------------------------

/**
 * Full context required by `executeUserInput()`.
 *
 * Extends `ProcessInputFullContext` with:
 *   - `onQuery` — callback that fires the actual API call after all messages are built.
 *   - `onNextInput` / `enqueueNextInput` — optional handlers for slash command chain prompts.
 *   - `querySource` — diagnostic tag propagated to `processUserInput`.
 */
export interface ExecuteInputContext extends ProcessInputFullContext {
  /** Per-prompt ID shared by processUserInput() and query() hook lifecycle. */
  promptId?: string;

  /** Preallocated Task/request-set id stamped onto the human input message. */
  taskId?: string;

  /**
   * Trigger the API call (`query()`) with the assembled messages.
   * Not called when `shouldQuery === false` (local commands).
   */
  onQuery: (messages: Message[], allowedTools?: string[]) => Promise<void>;

  /**
   * Display (but don't auto-submit) a follow-up prompt in the TUI input box.
   * Called when `result.nextInput` is set and `result.submitNextInput` is falsy.
   */
  onNextInput?: (input: string) => void;

  /**
   * Queue a follow-up prompt for automatic submission on the next turn.
   * Called when `result.nextInput` is set and `result.submitNextInput` is true.
   */
  enqueueNextInput?: (input: string) => void;

  /** Diagnostic source tag. */
  querySource?: string;
}

// ---------------------------------------------------------------------------
// executeUserInput
// ---------------------------------------------------------------------------

/**
 * Process and execute a batch of `QueuedCommand` entries.
 *
 * For a typical single-command flow (the common case), this:
 *   1. Calls `processUserInput()` for the command.
 *   2. Appends its `messages` to the batch accumulator.
 *   3. Calls `context.onQuery(allMessages)` to trigger the API call.
 *
 * For a multi-command batch (queued while a query was in progress):
 *   - First command brings `pastedContents`.
 *   - Subsequent commands skip attachment extraction (`skipAttachments: true`).
 *   - All resulting messages are concatenated before a single `onQuery` call.
 *
 * @param commands Ordered list of commands to execute (typically 1, may be N).
 * @param context Dependencies and callbacks.
 */
export async function executeUserInput(
  commands: QueuedCommand[],
  context: ExecuteInputContext,
): Promise<ExecuteInputResult> {
  if (commands.length === 0) {
    return { messages: [], shouldQuery: false };
  }

  const executionCommands = coalesceFreshPeerCommands(commands);
  const laterSelectedSkillCommandIndex = executionCommands.findIndex(
    (command, index) => index > 0 && Boolean(command.selectedSkills?.length),
  );
  if (laterSelectedSkillCommandIndex >= 0) {
    throw new SelectedSkillActivationError(
      `selected_skills must belong to the first command in a batch; command ${laterSelectedSkillCommandIndex + 1} contains a selection.`,
    );
  }
  // A failing later command discards the whole batch, including attachments
  // generated by earlier commands.
  const restoreAttachmentDeltaState = snapshotAttachmentDeltaState(
    context.attachmentCtx,
  );
  try {
    return await executeCommands(executionCommands, context);
  } catch (error) {
    restoreAttachmentDeltaState();
    throw error;
  }
}

async function executeCommands(
  executionCommands: QueuedCommand[],
  context: ExecuteInputContext,
): Promise<ExecuteInputResult> {
  const allMessages: Message[] = [];
  let shouldQuery = false;
  let allowedTools: string[] | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let commandInvocationId: string | undefined;
  let resultText: string | undefined;
  let resultIsError: boolean | undefined;
  let terminalReason: string | undefined;
  let errorCode: number | string | undefined;
  let hookStop: { stopReason?: string } | undefined;
  let nextInput: string | undefined;
  let submitNextInput: boolean | undefined;

  for (let i = 0; i < executionCommands.length; i++) {
    const cmd = executionCommands[i];
    const isFirst = i === 0;
    if (context.promptId) {
      emitInputPromptReceived({
        sessionId: context.sessionId,
        turnId: context.promptId,
        prompt:
          typeof cmd.prompt === 'string'
            ? cmd.prompt
            : extractTextFromBlocks(cmd.prompt),
        commandMode: cmd.commandMode,
        querySource: context.querySource,
        bridgeOrigin: cmd.bridgeOrigin,
        skipSlashCommands: cmd.skipSlashCommands,
      });
    }

    // Before processing: a peer @-mention in this prompt is recorded while it
    // is processed, and the user's message is what resets the reply-loop count.
    if (isHumanCommand(cmd, deriveOrigin(cmd))) noteHumanTurn();

    // Build per-command ProcessInputRequest
    const request = {
      input: cmd.prompt,
      preExpansionInput: cmd.preExpansionPrompt,
      suppressWorkflowKeyword: cmd.suppressWorkflowKeyword,
      commandMode: cmd.commandMode,
      // Only first command carries clipboard images
      pastedContents: isFirst ? cmd.pastedContents : undefined,
      // Skip attachment extraction for 2nd+ commands to avoid re-injection
      skipAttachments: !isFirst,
      skipSlashCommands: cmd.skipSlashCommands,
      selectedSkills: cmd.selectedSkills,
      bridgeOrigin: cmd.bridgeOrigin,
      isMeta: cmd.isMeta,
      isVisibleInTranscriptOnly: cmd.isVisibleInTranscriptOnly,
      uuid: cmd.uuid,
      promptId: context.promptId,
      requestSetId: context.taskId,
      querySource: context.querySource,
    };

    const result: ProcessInputResult = await processUserInput(request, context);

    const origin = deriveOrigin(cmd);

    if (origin) {
      for (const msg of result.messages) {
        if (msg.type !== 'user') continue;
        const content = msg.message.content;
        // 工具结果归属于调用，不接收提示词的来源标记或文本包装。
        if (typeof content !== 'string' && content.length > 0 &&
            content.every((block) => block.type === 'tool_result')) continue;
        msg.origin = origin;
        if (origin.kind === 'task-notification' && msg.isMeta === undefined) {
          msg.isMeta = true;
        }
        if (typeof content === 'string') {
          msg.message.content = wrapTextByOrigin(content, origin, { midTurn: false });
        } else {
          const firstTextIndex = content.findIndex((block) => block.type === 'text');
          msg.message.content = content.map((block, index) =>
            index === firstTextIndex && block.type === 'text'
              ? { ...block, text: wrapTextByOrigin(block.text, origin, { midTurn: false }) }
              : block,
          );
        }
      }
    }

    if (cmd.isUserDecision) {
      for (const msg of result.messages) {
        if (msg.type === 'user') msg.isUserDecision = true;
      }
    }

    if (result.shouldQuery) {
      stampHumanInput(result.messages, cmd, origin, context.taskId);
    }

    allMessages.push(...result.messages);

    // First command's shouldQuery / allowedTools determine whether to call the API
    if (isFirst) {
      shouldQuery = result.shouldQuery;
      allowedTools = result.allowedTools;
      model = result.model;
      effort = result.effort;
      commandInvocationId = result.commandInvocationId;
      resultText = result.resultText;
      resultIsError = result.resultIsError;
      terminalReason = result.terminalReason;
      errorCode = result.errorCode;
      hookStop = result.hookStop;
      nextInput = result.nextInput;
      submitNextInput = result.submitNextInput;
    }

    // Handle chain prompts from slash commands (e.g. /discover filling the next prompt)
    if (result.nextInput) {
      if (result.submitNextInput) {
        context.enqueueNextInput?.(result.nextInput);
      } else {
        context.onNextInput?.(result.nextInput);
      }
    }
  }

  // Fire the API call if any command produced queryable messages
  if (allMessages.length > 0 && shouldQuery) {
    await context.onQuery(allMessages, allowedTools);
  }
  // else: local command (e.g. /model, /theme) — no API call needed

  return {
    messages: allMessages,
    shouldQuery,
    allowedTools,
    model,
    effort,
    commandInvocationId,
    resultText,
    resultIsError,
    terminalReason,
    errorCode,
    hookStop,
    nextInput,
    submitNextInput,
  };
}

function isHumanCommand(
  command: QueuedCommand,
  origin: MessageOrigin | undefined,
): boolean {
  if (
    command.commandMode === 'task-notification' ||
    command.commandMode === 'orphaned-permission' ||
    command.bridgeOrigin ||
    command.targetAgentId !== undefined ||
    command.isMeta === true
  ) {
    return false;
  }
  if (command.origin !== undefined) {
    return origin?.kind === 'human';
  }
  if (origin && origin.kind !== 'human') {
    return false;
  }
  return command.commandMode === 'prompt' || command.commandMode === 'bash';
}

function stampHumanInput(
  messages: Message[],
  command: QueuedCommand,
  origin: MessageOrigin | undefined,
  taskId: string | undefined,
): void {
  if (!isHumanCommand(command, origin)) {
    return;
  }
  const text = getOriginalInputText(command);
  const userMessages = messages.filter(
    (message): message is UserMessage => message.type === 'user',
  );
  const anchor =
    userMessages.find((message) =>
      message.uuid === command.uuid && !isToolResultUserMessage(message),
    ) ??
    (command.commandMode === 'bash'
      ? userMessages.find(isBashInputMessage)
      : undefined) ??
    userMessages.find((message) => !isToolResultUserMessage(message));
  if (!anchor) {
    return;
  }
  for (const message of userMessages) {
    if (message !== anchor) {
      delete message.humanInput;
    }
  }
  anchor.humanInput = {
    text,
    mode: command.commandMode === 'bash' ? 'bash' : 'prompt',
  };
  if (taskId) {
    anchor.requestSetId = taskId;
  }
}

function getOriginalInputText(command: QueuedCommand): string {
  if (command.preExpansionPrompt?.trim()) {
    return command.preExpansionPrompt;
  }
  return typeof command.prompt === 'string'
    ? command.prompt
    : extractTextFromBlocks(command.prompt);
}

function isBashInputMessage(message: UserMessage): boolean {
  const content = message.message.content;
  if (typeof content === 'string') {
    return parseBashInputPromptText(content) !== null;
  }
  return content.some(
    (block) =>
      block.type === 'text' && parseBashInputPromptText(block.text) !== null,
  );
}
