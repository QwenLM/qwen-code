/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Message,
  UserMessage,
} from '../../protocol/transcript/message.js';
import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import {
  getDisplayableUserText,
  getUserTextBlocks,
  parseBashInputPromptText,
  parseCommandPromptText,
} from '../../protocol/transcript/message-utils.js';
import { runLogger } from '../../utils/runLogger.js';
import { isChainParticipant } from './session-writer.js';
import type { RecordActiveLeafOptions } from './session-writer.js';
import { randomUUID } from 'node:crypto';
import { selectHistoricalLineage } from './historical-lineage.js';

export interface RewindCandidate {
  message: UserMessage;
  displayText: string;
  prefillText: string;
  inputMode: 'prompt' | 'bash';
}

export interface ConversationRewindPlan {
  target: RewindCandidate;
  retainedMessages: readonly Message[];
  retainedLeafUuid: string | null;
  removedMessageIds?: readonly string[];
}

export interface ConversationRewindState {
  sessionId: string;
  messages: readonly Message[];
  leafUuid: string | null;
  guardRevision: number;
}

export interface ConversationRewindAdapter {
  readState(): ConversationRewindState;
  assertReady(state: ConversationRewindState): void;
  commit(plan: ConversationRewindPlan): void;
  restore(): void;
}

export type ConversationRewindPlanResolver = (
  state: ConversationRewindState,
  targetUuid: string,
) => ConversationRewindPlan | Promise<ConversationRewindPlan>;

export interface ConversationRewindWriter {
  recordActiveLeaf(
    leafUuid: string | null,
    options: RecordActiveLeafOptions,
  ): Promise<void>;
}

export type ConversationRewindErrorCode =
  | 'not-ready'
  | 'target-not-found'
  | 'state-changed'
  | 'persistence-failed'
  | 'compensation-failed';

export interface ConversationRewindOutcome {
  rewindId: string;
  targetMessageId: string;
  targetTaskId?: string;
  preMessageCount?: number;
  postMessageCount?: number;
  outcome: 'success' | 'failed';
  errorCode?: ConversationRewindErrorCode;
}

export class ConversationRewindError extends Error {
  readonly compensationCause?: unknown;

  constructor(
    readonly code: ConversationRewindErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      compensationCause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'ConversationRewindError';
    if (options?.compensationCause !== undefined) {
      this.compensationCause = options.compensationCause;
    }
  }
}

export function getRewindCandidates(
  messages: readonly Message[],
): RewindCandidate[] {
  return messages.flatMap((message) => {
    const candidate = toRewindCandidate(message);
    return candidate ? [candidate] : [];
  });
}

export function planConversationRewind(
  messages: readonly Message[],
  targetUuid: string,
): ConversationRewindPlan {
  const target = getRewindCandidates(messages).find(
    (candidate) => candidate.message.uuid === targetUuid,
  );
  const targetIndex = messages.findIndex(
    (message) => message.type === 'user' && message.uuid === targetUuid,
  );
  if (!target || targetIndex < 0) {
    throw new ConversationRewindError(
      'target-not-found',
      `Rewind target is not an eligible human input: ${targetUuid}`,
    );
  }
  const retainedMessages = messages.slice(0, targetIndex);
  let retainedLeafUuid: string | null = null;
  for (let index = retainedMessages.length - 1; index >= 0; index--) {
    const message = retainedMessages[index];
    if (message && isChainParticipant(message)) {
      retainedLeafUuid = message.uuid;
      break;
    }
  }
  return {
    target,
    retainedMessages,
    retainedLeafUuid,
    removedMessageIds: messages.slice(targetIndex).map((message) => message.uuid),
  };
}

/** Builds a Rewind plan from the complete historical lineage. */
export function planHistoricalConversationRewind(
  lineage: readonly TranscriptMessage[],
  targetUuid: string,
): ConversationRewindPlan {
  const selection = selectHistoricalLineage(
    lineage,
    targetUuid,
    'before-target',
  );
  const target = selection ? toRewindCandidate(selection.target) : undefined;
  if (!selection || !target) {
    throw new ConversationRewindError(
      'target-not-found',
      `Rewind target is not an eligible human input: ${targetUuid}`,
    );
  }
  return {
    target,
    retainedMessages: selection.runtimeMessages,
    retainedLeafUuid: selection.retainedLeafUuid,
    removedMessageIds: selection.discardedChain
      .filter(
        (message) =>
          message.isCompactSummary !== true &&
          !(message.type === 'system' && message.subtype === 'compact_boundary'),
      )
      .map((message) => message.uuid),
  };
}

export async function executeConversationRewind({
  targetUuid,
  writer,
  adapter,
  resolvePlan,
  onOutcome,
}: {
  targetUuid: string;
  writer?: ConversationRewindWriter;
  adapter: ConversationRewindAdapter;
  resolvePlan?: ConversationRewindPlanResolver;
  onOutcome?: (outcome: ConversationRewindOutcome) => void;
}): Promise<ConversationRewindPlan> {
  const rewindId = randomUUID();
  let before: ConversationRewindState | undefined;
  const report = (
    outcome: ConversationRewindOutcome['outcome'],
    extra: {
      postMessageCount?: number;
      errorCode?: ConversationRewindErrorCode;
    },
  ): void => {
    try {
      onOutcome?.({
        rewindId,
        targetMessageId: targetUuid,
        targetTaskId: getTargetTaskId(before, targetUuid),
        preMessageCount: before?.messages.length,
        outcome,
        ...extra,
      });
    } catch (error) {
      runLogger.debug('conversation.rewind', 'outcome_callback_failed', error);
    }
  };

  try {
    if (!writer) {
      throw new ConversationRewindError(
        'not-ready',
        'Conversation Rewind requires an active transcript writer.',
      );
    }
    before = adapter.readState();
    adapter.assertReady(before);
    const plan = await executeConversationRewindImpl({
      targetUuid,
      writer,
      adapter,
      before,
      resolvePlan,
    });
    report('success', { postMessageCount: plan.retainedMessages.length });
    return plan;
  } catch (error) {
    const rewindError = normalizeReadinessError(error);
    report('failed', { errorCode: rewindError.code });
    throw rewindError;
  }
}

async function executeConversationRewindImpl({
  targetUuid,
  writer,
  adapter,
  before,
  resolvePlan,
}: {
  targetUuid: string;
  writer: ConversationRewindWriter;
  adapter: ConversationRewindAdapter;
  before: ConversationRewindState;
  resolvePlan?: ConversationRewindPlanResolver;
}): Promise<ConversationRewindPlan> {
  logPhase('prepare', before, targetUuid);
  const plan = resolvePlan
    ? await resolvePlan(before, targetUuid)
    : planConversationRewind(before.messages, targetUuid);

  try {
    const prePersist = adapter.readState();
    adapter.assertReady(prePersist);
    assertSameState(before, prePersist);
  } catch (error) {
    logFailure(before, targetUuid, error);
    throw normalizeReadinessError(error);
  }

  logPhase('persist', before, targetUuid, plan.retainedLeafUuid);
  try {
    await writer.recordActiveLeaf(plan.retainedLeafUuid, {
      explicit: true,
      rewound: true,
      durable: true,
    });
  } catch (error) {
    const rewindError = new ConversationRewindError(
      'persistence-failed',
      'Failed to persist the rewound conversation branch.',
      { cause: error },
    );
    logFailure(before, targetUuid, rewindError);
    throw rewindError;
  }

  try {
    const preCommit = adapter.readState();
    adapter.assertReady(preCommit);
    assertSameState(before, preCommit);
    adapter.commit(plan);
    logPhase('commit', before, targetUuid, plan.retainedLeafUuid);
    return plan;
  } catch (error) {
    let restoreError: unknown;
    try {
      adapter.restore();
    } catch (nextError) {
      restoreError = nextError;
    }

    logPhase('compensate', before, targetUuid, before.leafUuid);
    try {
      await writer.recordActiveLeaf(before.leafUuid, {
        explicit: true,
        rewound: false,
        durable: true,
      });
    } catch (compensationCause) {
      const rewindError = new ConversationRewindError(
        'compensation-failed',
        'Rewind failed and the previous active branch could not be restored.',
        {
          cause: combineCauses(error, restoreError),
          compensationCause,
        },
      );
      logFailure(before, targetUuid, rewindError);
      throw rewindError;
    }

    const rewindError = normalizePostPersistError(error, restoreError);
    logFailure(before, targetUuid, rewindError);
    throw rewindError;
  }
}

function getTargetTaskId(
  state: ConversationRewindState | undefined,
  targetUuid: string,
): string | undefined {
  const target = state?.messages.find(
    (message): message is UserMessage =>
      message.type === 'user' && message.uuid === targetUuid,
  );
  return target?.requestSetId;
}

function toRewindCandidate(message: Message): RewindCandidate | undefined {
  if (
    message.type !== 'user' ||
    message.parent_tool_use_id ||
    message.agentId ||
    message.teamName ||
    message.isCompactSummary === true ||
    message.isVisibleInTranscriptOnly === true ||
    message.isVirtual === true ||
    message.toolUseResult !== undefined ||
    (message.origin !== undefined && message.origin.kind !== 'human') ||
    containsToolResult(message)
  ) {
    return undefined;
  }

  const snapshot = message.humanInput;
  if (snapshot?.text.trim()) {
    if (message.isMeta === true && snapshot.mode !== 'bash') {
      return undefined;
    }
    return {
      message,
      displayText: normalizeDisplayText(snapshot.text),
      prefillText: snapshot.text,
      inputMode: snapshot.mode,
    };
  }

  const bashCommand = getLegacyBashCommand(message);
  if (bashCommand) {
    return {
      message,
      displayText: normalizeDisplayText(bashCommand),
      prefillText: bashCommand,
      inputMode: 'bash',
    };
  }
  if (message.isMeta === true) {
    return undefined;
  }
  if (containsSlashCommandMetadata(message)) {
    return undefined;
  }
  const legacyText = getDisplayableUserText(message);
  if (!legacyText) {
    return undefined;
  }
  return {
    message,
    displayText: normalizeDisplayText(legacyText),
    prefillText: legacyText,
    inputMode: 'prompt',
  };
}

function containsSlashCommandMetadata(message: UserMessage): boolean {
  return getUserTextBlocks(message).some(
    (text) => parseCommandPromptText(text) !== null,
  );
}

function getLegacyBashCommand(message: UserMessage): string | undefined {
  for (const text of getUserTextBlocks(message)) {
    const display = parseBashInputPromptText(text);
    if (display?.startsWith('! ')) {
      return display.slice(2);
    }
  }
  return undefined;
}

function containsToolResult(message: UserMessage): boolean {
  return (
    Array.isArray(message.message.content) &&
    message.message.content.some((block) => block.type === 'tool_result')
  );
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function assertSameState(
  expected: ConversationRewindState,
  actual: ConversationRewindState,
): void {
  const sameMessages =
    expected.messages.length === actual.messages.length &&
    expected.messages.every(
      (message, index) => message.uuid === actual.messages[index]?.uuid,
    );
  if (
    expected.sessionId !== actual.sessionId ||
    expected.leafUuid !== actual.leafUuid ||
    expected.guardRevision !== actual.guardRevision ||
    !sameMessages
  ) {
    throw new ConversationRewindError(
      'state-changed',
      'Conversation state changed while Rewind was being prepared.',
    );
  }
}

function normalizeReadinessError(error: unknown): ConversationRewindError {
  return error instanceof ConversationRewindError
    ? error
    : new ConversationRewindError(
        'not-ready',
        'Conversation is not ready to rewind.',
        { cause: error },
      );
}

function normalizePostPersistError(
  error: unknown,
  restoreError: unknown,
): ConversationRewindError {
  const cause = combineCauses(error, restoreError);
  if (error instanceof ConversationRewindError && restoreError === undefined) {
    return error;
  }
  return new ConversationRewindError(
    error instanceof ConversationRewindError ? error.code : 'state-changed',
    error instanceof Error
      ? error.message
      : 'Conversation state could not be committed after Rewind.',
    { cause },
  );
}

function combineCauses(error: unknown, restoreError: unknown): unknown {
  return restoreError === undefined
    ? error
    : new AggregateError(
        [error, restoreError],
        'Rewind and runtime restoration both failed.',
      );
}

function logPhase(
  phase: 'prepare' | 'persist' | 'commit' | 'compensate',
  state: ConversationRewindState,
  targetUuid: string,
  nextLeafUuid?: string | null,
): void {
  runLogger.debug(
    'conversation.rewind',
    `phase=${phase}`,
    `session=${state.sessionId}`,
    `target=${targetUuid}`,
    `old_leaf=${state.leafUuid ?? 'null'}`,
    ...(nextLeafUuid !== undefined
      ? [`new_leaf=${nextLeafUuid ?? 'null'}`]
      : []),
  );
}

function logFailure(
  state: ConversationRewindState,
  targetUuid: string,
  error: unknown,
): void {
  runLogger.debug(
    'conversation.rewind',
    'phase=failed',
    `session=${state.sessionId}`,
    `target=${targetUuid}`,
    `old_leaf=${state.leafUuid ?? 'null'}`,
    `code=${
      error instanceof ConversationRewindError ? error.code : 'unknown'
    }`,
  );
}
