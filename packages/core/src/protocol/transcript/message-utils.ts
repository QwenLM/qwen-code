/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BASH_INPUT_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xmlTags.js';
import { isCommandStyleUserPromptText } from '../../utils/commandStyleText.js';
import type { Message, TranscriptAttachment, UserMessage } from './message.js';

// ---------------------------------------------------------------------------
// Task lifecycle subtype helpers
// ---------------------------------------------------------------------------

/** Subtypes of system messages that carry task lifecycle (SDK-only) events. */
export const TASK_LIFECYCLE_SUBTYPES: ReadonlySet<string> = new Set([
  'background_tasks_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
  'permission_denied',
]);

export function isTaskLifecycleSubtype(subtype: string): boolean {
  return TASK_LIFECYCLE_SUBTYPES.has(subtype);
}

/**
 * Validates attachment payloads loaded from a transcript before they enter
 * runtime history. The checks enforce a resume boundary: every
 * payload needs a string discriminator, while attachment types whose
 * normalizers dereference structured fields receive stricter validation.
 */
export function isWellFormedAttachmentPayload(
  value: unknown,
): value is TranscriptAttachment {
  if (value === null || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  const { type, skills, content, names, hookEventName, output } = attachment;
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'invoked_skills':
      return (
        Array.isArray(skills) &&
        skills.every((skill) => skill !== null && typeof skill === 'object')
      );
    case 'hook_success':
      return typeof content === 'string';
    case 'skill_listing':
      return (
        names === undefined ||
        (Array.isArray(names) &&
          names.every((name) => typeof name === 'string'))
      );
    case 'hook_output':
      return typeof hookEventName === 'string' && typeof output === 'string';
    default:
      return true;
  }
}

export const INTERRUPT_MESSAGE = '[Request interrupted by user]';
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]';
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
/**
 * A rejection does not end the turn here — the model carries on with the refusal
 * in context — so this must not tell it to stop and wait for the user. It says
 * what did not happen and what to do instead.
 */
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Do not repeat this call; take a different approach, or if you cannot proceed without it, tell the user what you were trying to do and why you need it.";
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
export const NO_RESPONSE_REQUESTED = 'No response requested.';

/** The model-facing text for a call the user rejected, with their feedback if any. */
export function formatUserRejection(feedback?: string): string {
  const trimmed = feedback?.trim();
  return trimmed ? `${REJECT_MESSAGE_WITH_REASON_PREFIX}${trimmed}` : REJECT_MESSAGE;
}

export const SYNTHETIC_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
]);

// Pre-compiled regexes for parsing command and bash-input XML tags.
const COMMAND_NAME_RE = new RegExp(
  `<${COMMAND_NAME_TAG}>([\\s\\S]*?)</${COMMAND_NAME_TAG}>`,
);
const COMMAND_ARGS_RE = new RegExp(
  `<${COMMAND_ARGS_TAG}>([\\s\\S]*?)</${COMMAND_ARGS_TAG}>`,
);
const BASH_INPUT_RE = new RegExp(
  `<${BASH_INPUT_TAG}>([\\s\\S]*?)</${BASH_INPUT_TAG}>`,
);
const LOCAL_COMMAND_STDOUT_RE = new RegExp(
  `^<${LOCAL_COMMAND_STDOUT_TAG}>([\\s\\S]*)</${LOCAL_COMMAND_STDOUT_TAG}>$`,
);

/**
 * Scans all user messages for tool_result blocks and builds a map from
 * tool_use_id to its final status ('completed' or 'error').
 */
export function collectToolStatuses(
  messages: readonly Message[],
): Map<string, 'completed' | 'error'> {
  const statuses = new Map<string, 'completed' | 'error'>();

  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue;
    }

    for (const block of message.message.content) {
      if (block.type === 'tool_result') {
        statuses.set(block.tool_use_id, block.is_error ? 'error' : 'completed');
      }
    }
  }

  return statuses;
}

/**
 * Extracts text blocks from an assistant message, returning them trimmed and
 * with empty entries filtered out.
 */
export function getAssistantTextBlocks(
  message: Extract<Message, { type: 'assistant' }>,
): string[] {
  return message.message.content
    .filter(
      (
        block,
      ): block is Extract<
        (typeof message.message.content)[number],
        { type: 'text' }
      > => block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text.trim())
    .filter(Boolean);
}

export function getUserTextBlocks(
  message: Pick<UserMessage, 'message'>,
): string[] {
  const content = message.message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [text] : [];
  }

  // Runtime content can be null (e.g. a user message assembled from a
  // non-command slash input, or a malformed persisted entry). Degrade to no
  // text instead of throwing and taking down every transcript consumer
  // (writer prompt extraction, rewind, catalog scans) with it.
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: 'text' }> =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text.trim())
    .filter(Boolean);
}

export function isSyntheticPromptText(text: string): boolean {
  return SYNTHETIC_MESSAGES.has(text.trim());
}

export function isSyntheticMessage(message: Message): boolean {
  if (message.type !== 'user' && message.type !== 'assistant') {
    return false;
  }

  const content = message.message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  const firstBlock = content[0];
  return firstBlock?.type === 'text' && isSyntheticPromptText(firstBlock.text);
}

/**
 * Returns whether a processed user message may be projected as an SDK replay.
 *
 * Model-only metadata, transcript-only entries, tool results, compact summaries,
 * and internal synthetic markers remain in conversation state but are not
 * replayed as user input. This replayable-user-message selection is used
 * instead of attaching transport visibility flags to command results.
 */
export function isReplayableUserMessage(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') {
    return false;
  }
  if (
    message.isMeta === true ||
    message.isCompactSummary === true ||
    message.isVisibleInTranscriptOnly === true ||
    message.toolUseResult !== undefined
  ) {
    return false;
  }

  const content = message.message.content;
  if (Array.isArray(content) && content[0]?.type === 'tool_result') {
    return false;
  }

  return !isSyntheticMessage(message);
}

const LEADING_INTERNAL_CONTEXT_TAGS = new Set([
  'system-reminder',
  'hook_context',
  LOCAL_COMMAND_CAVEAT_TAG,
  'loaded_context',
]);

function stripLeadingInternalContextBlocks(text: string): string {
  let remaining = text.trim();

  while (remaining.startsWith('<')) {
    const open = remaining.match(/^<([a-z][\w-]*)(?:\s[^>]*)?>/);
    const tagName = open?.[1];
    if (!tagName || !LEADING_INTERNAL_CONTEXT_TAGS.has(tagName)) {
      break;
    }

    const closeTag = `</${tagName}>`;
    const end = remaining.indexOf(closeTag);
    if (end < 0) {
      break;
    }

    remaining = remaining.slice(end + closeTag.length).trim();
  }

  return remaining;
}

export { isCommandStyleUserPromptText };

export function parseCommandPromptText(text: string): string | null {
  const commandNameMatch = text.match(COMMAND_NAME_RE);
  if (!commandNameMatch) {
    return null;
  }

  const commandName = commandNameMatch[1]?.trim();
  if (!commandName) {
    return null;
  }

  const argsMatch = text.match(COMMAND_ARGS_RE);
  const args = argsMatch?.[1]?.trim();
  return args ? `${commandName} ${args}` : commandName;
}

export function parseBashInputPromptText(text: string): string | null {
  const match = text.match(BASH_INPUT_RE);
  const command = match?.[1]?.trim();
  return command ? `! ${command}` : null;
}

export function parseLocalCommandStdoutText(text: string): string | null {
  const match = text.match(LOCAL_COMMAND_STDOUT_RE);
  if (!match) {
    return null;
  }

  const output = match[1] ?? '';
  return output.trim() ? output : null;
}

const RAW_XML_TAG_RE = /^<[a-z][\w-]*(?:\s|>)/;

/** Tests whether already-stripped text still begins with a raw XML tag. */
function startsWithRawXmlTag(text: string): boolean {
  return RAW_XML_TAG_RE.test(text);
}

/**
 * Classifies a single text block into one of three categories:
 * - `'real'`: normal human-authored prompt text (with normalized whitespace)
 * - `'fallback'`: command/bash-input displayable text (not a "real" prompt)
 * - `null`: internal/system payload that should not be displayed
 */
function classifyTextBlock(
  text: string,
): { kind: 'real'; text: string } | { kind: 'fallback'; text: string } | null {
  const visibleText = stripLeadingInternalContextBlocks(text);
  if (!visibleText) {
    return null;
  }

  const command = parseCommandPromptText(visibleText);
  if (command) {
    return { kind: 'fallback', text: command };
  }

  const bashInput = parseBashInputPromptText(visibleText);
  if (bashInput) {
    return { kind: 'fallback', text: bashInput };
  }

  if (isCommandStyleUserPromptText(visibleText)) {
    return {
      kind: 'fallback',
      text: visibleText.replace(/\s+/g, ' ').trim(),
    };
  }

  if (startsWithRawXmlTag(visibleText)) {
    return null;
  }

  const normalized = visibleText.replace(/\s+/g, ' ').trim();
  if (normalized) {
    return { kind: 'real', text: normalized };
  }

  return null;
}

export function getRealUserPromptText(message: Message): string | null {
  if (!isMeaningfulUserPromptMessage(message)) {
    return null;
  }

  if (message.origin && message.origin.kind !== 'human') {
    return null;
  }

  for (const text of getUserTextBlocks(message)) {
    const classified = classifyTextBlock(text);
    if (classified?.kind === 'real') {
      return classified.text;
    }
  }

  return null;
}

export function getUserPromptFallbackText(message: Message): string | null {
  if (!isMeaningfulUserPromptMessage(message)) {
    return null;
  }

  for (const text of getUserTextBlocks(message)) {
    const classified = classifyTextBlock(text);
    if (classified?.kind === 'fallback') {
      return classified.text;
    }
  }

  return null;
}

/**
 * Converts a stored prompt string into a displayable form. Returns `undefined`
 * for internal payloads that should not be shown.
 */
interface DisplayablePromptTextOptions {
  preservePlainTextWhitespace?: boolean;
}

export function getDisplayablePromptText(
  prompt: string | undefined,
  options: DisplayablePromptTextOptions = {},
): string | undefined {
  if (!prompt) {
    return undefined;
  }

  const visiblePrompt = stripLeadingInternalContextBlocks(prompt);
  if (!visiblePrompt) {
    return undefined;
  }

  if (isSyntheticPromptText(visiblePrompt)) {
    return undefined;
  }

  const command = parseCommandPromptText(visiblePrompt);
  if (command) {
    return command;
  }

  const bashInput = parseBashInputPromptText(visiblePrompt);
  if (bashInput) {
    return bashInput;
  }

  const localCommandOutput = parseLocalCommandStdoutText(visiblePrompt);
  if (localCommandOutput) {
    return localCommandOutput;
  }

  if (startsWithRawXmlTag(visiblePrompt)) {
    return undefined;
  }

  const normalized = options.preservePlainTextWhitespace
    ? visiblePrompt.trim()
    : visiblePrompt.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

export function getDisplayableUserText(
  message: Pick<UserMessage, 'message'>,
): string | undefined {
  const text = getUserTextBlocks(message)
    .map((block) =>
      getDisplayablePromptText(block, {
        preservePlainTextWhitespace: true,
      }),
    )
    .filter((block): block is string => block !== undefined)
    .join('\n');
  return text.trim() ? text : undefined;
}

export function isHiddenUserMessageInDefaultHistory(
  message: Pick<UserMessage, 'isMeta' | 'isVisibleInTranscriptOnly'> &
    Partial<Pick<UserMessage, 'message'>>,
): boolean {
  if (message.isMeta === true || message.isVisibleInTranscriptOnly === true) {
    return true;
  }

  if (message.message !== undefined) {
    const content = message.message.content;
    return (
      Array.isArray(content) &&
      content[0]?.type === 'text' &&
      isSyntheticPromptText(content[0].text)
    );
  }

  return false;
}

export function isToolResultUserMessage(
  message: Message,
): message is UserMessage {
  return (
    message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.length > 0 &&
    message.message.content.every((block) => block.type === 'tool_result')
  );
}

/**
 * A human-typed prompt that starts a task: not a meta message, not a tool
 * result, and entered as a prompt rather than a bash/command input mode.
 */
export function isHumanTaskInputMessage(
  message: Message,
): message is UserMessage {
  return (
    message.type === 'user' &&
    message.origin?.kind === 'human' &&
    message.isMeta !== true &&
    message.humanInput?.mode === 'prompt' &&
    !isToolResultUserMessage(message)
  );
}

/**
 * Whether `userMessageUuid` names a human-typed prompt in `messages` — the one
 * rule that decides `user_prompt` vs `continuation` for `task_started.trigger`.
 * Every host must derive it the same way or the same situation reports a
 * different trigger per surface. Scans from the tail: the message in question
 * was just appended.
 */
export function isTaskTriggeringPrompt(
  messages: readonly Message[],
  userMessageUuid: string | undefined,
): boolean {
  if (!userMessageUuid) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.uuid === userMessageUuid) {
      return isHumanTaskInputMessage(message);
    }
  }
  return false;
}

export function isMeaningfulUserPromptMessage(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') {
    return false;
  }

  if (
    isHiddenUserMessageInDefaultHistory(message) ||
    message.isCompactSummary === true ||
    isToolResultUserMessage(message)
  ) {
    return false;
  }

  return getDisplayableUserText(message) !== undefined;
}

export function countHumanPromptMessages(messages: readonly Message[]): number {
  return messages.filter(
    (message) =>
      message.type === 'user' && message.humanInput?.mode === 'prompt',
  ).length;
}

export function isAiTitleCadenceHumanPromptMessage(
  message: Message,
): message is UserMessage {
  return getRealUserPromptText(message) !== null;
}

export function countAiTitleCadenceHumanPromptMessages(
  messages: readonly Message[],
): number {
  return messages.filter(isAiTitleCadenceHumanPromptMessage).length;
}
