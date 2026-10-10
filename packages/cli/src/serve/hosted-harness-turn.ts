/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  createManagedHarnessHandle,
  type ManagedHarnessHandle,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  ManagedHookActivationController,
  type ManagedMainModelAttempt,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';
import {
  HostedHookRecoveryRequiredError,
  type HostedHookSession,
} from './hosted-hook-session.js';
import { HostedMcpRecoveryRequiredError } from './hosted-mcp-session.js';
import { HostedTextDeltaStream } from './hosted-text-deltas.js';
import {
  HostedToolRecoveryRequiredError,
  isRetryableWorkspaceAcquisition,
  type HostedWorkspaceToolTurn,
  type HostedWorkspaceContextSlot,
} from './hosted-workspace-tool-turn.js';

export interface HostedTurnSession {
  managed: ManagedSession;
  cwd: string;
  blocked: boolean;
  hooks?: HostedHookSession;
  workspaceContext?: string;
}

export type HostedTurnCommit = (
  type: 'assistant' | 'tool_result',
  parts: Part[],
  model: string,
  identity?: { uuid: string; timestamp: string },
) => Promise<string>;

export type HostedToolTurn = Pick<
  HostedWorkspaceToolTurn,
  'declarations' | 'execute' | 'consumeResults' | 'finish' | 'close'
> &
  Partial<
    Pick<
      HostedWorkspaceToolTurn,
      | 'setPromptHookRunner'
      | 'resumeHookResults'
      | 'hookStopReason'
      | 'resumeCommittedResults'
    >
  >;

interface HostedTurnOptions {
  session: HostedTurnSession;
  sessionId: string;
  cwd: string;
  promptId: string;
  text: string;
  abort: AbortController;
  historyMode: 'all' | 'settled';
  createToolTurn?: (
    harness: ManagedHarnessHandle,
    commit: HostedTurnCommit,
    messageFitsInline: (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
    ) => boolean,
    workspaceContext: HostedWorkspaceContextSlot,
  ) => HostedToolTurn;
  resumeFromToolResults?: Part[];
  completeFinalOutput?: (
    attempt: ManagedMainModelAttempt,
    usage: unknown[],
    record: ChatRecord,
  ) => Promise<void>;
  recoveredFinalOutput?: ChatRecord;
  onTurnResult?: (result: ChatRecord) => void;
  onResumeReady?: () => void;
  onCompleted?: () => Promise<void>;
}

/**
 * The prompt deadline timer and the cancel route abort the same controller,
 * so the deadline aborts with a distinguishing reason; settlement reads it
 * back to keep an expiry from being recorded as a user cancellation.
 */
export const HOSTED_TURN_DEADLINE = new Error(
  'The Hosted Harness Turn deadline expired.',
);

/**
 * The terminal classification of a turn whose runner threw. A deadline
 * expiry is an attributable failure, never a cancellation.
 */
export function settledTurnOutcome(abort: AbortController): {
  state: 'cancelled' | 'error';
  stopReason: string;
} {
  if (!abort.signal.aborted) return { state: 'error', stopReason: 'error' };
  return abort.signal.reason === HOSTED_TURN_DEADLINE
    ? { state: 'error', stopReason: 'deadline_exceeded' }
    : { state: 'cancelled', stopReason: 'cancelled' };
}

export function createHostedChatRecord(
  session: Pick<HostedTurnSession, 'cwd'>,
  sessionId: string,
  type: ChatRecord['type'],
  parentUuid: string | null,
  fields: Partial<ChatRecord>,
): ChatRecord {
  return {
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: session.cwd,
    version: 'hosted-harness/1',
    ...fields,
  };
}

/**
 * The prompts whose turns settled without an answer (`error` or
 * `cancelled`). Turn results are `turn.settled` journal events, not
 * projected messages, so they never reach any record-based exclusion in
 * the model runner: the history is filtered against the journal here —
 * what ended without an answer is over, and its instruction never merges
 * into a later turn the way a crashing text turn's naked user record
 * otherwise would.
 */
export function unansweredPrompts(session: HostedTurnSession): Set<string> {
  const authority = session.managed.authority;
  const prompts = new Set<string>();
  for (const event of authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  )) {
    if (
      event.kind === 'turn.settled' &&
      (event.payload['outcome'] === 'error' ||
        event.payload['outcome'] === 'cancelled')
    ) {
      const turnId = event.payload['turnId'];
      if (typeof turnId === 'string') prompts.add(turnId);
    }
  }
  return prompts;
}

export async function runHostedHarnessTurn({
  session,
  sessionId,
  cwd,
  promptId,
  text,
  abort,
  historyMode,
  createToolTurn,
  resumeFromToolResults,
  completeFinalOutput,
  recoveredFinalOutput,
  onTurnResult,
  onResumeReady,
  onCompleted,
}: HostedTurnOptions): Promise<ChatRecord> {
  const authority = session.managed.authority;
  const harness = createManagedHarnessHandle(session.managed);
  let turnResult: ChatRecord | undefined;
  let toolTurn: HostedToolTurn | undefined;
  const running = new ManagedHookActivationController(session.managed).runTurn(
    promptId,
    async (modelScope) =>
      harness.run(async () => {
        const projected = await session.managed.sink.project();
        const settledPrompts = new Set(
          authority
            .eventsInSequenceRange(1, authority.committedSequence)
            .filter((event) => event.kind === 'turn.settled')
            .map((event) => event.payload['turnId']),
        );
        const unanswered = unansweredPrompts(session);
        const history = (
          historyMode === 'settled'
            ? projected.filter(
                (entry) =>
                  settledPrompts.has(entry.daemonPromptId) ||
                  (resumeFromToolResults && entry.daemonPromptId === promptId),
              )
            : projected
        ).filter(
          (entry) =>
            !(
              entry.type === 'user' &&
              entry.daemonPromptId !== undefined &&
              unanswered.has(entry.daemonPromptId)
            ),
        );
        let parentUuid = projected.at(-1)?.uuid ?? null;
        if (!resumeFromToolResults) {
          const user = createHostedChatRecord(
            session,
            sessionId,
            'user',
            parentUuid,
            {
              daemonPromptId: promptId,
              message: { role: 'user', parts: [{ text }] },
            },
          );
          await session.managed.sink.write(user);
          parentUuid = user.uuid;
        }
        const messageRecord = (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: { uuid: string; timestamp: string },
        ) =>
          createHostedChatRecord(session, sessionId, type, parentUuid, {
            daemonPromptId: promptId,
            model,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
            ...identity,
          });
        const deltas =
          historyMode === 'settled'
            ? new HostedTextDeltaStream(session.managed, promptId)
            : undefined;
        const commit = async (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: { uuid: string; timestamp: string },
        ) => {
          const message = messageRecord(type, parts, model, identity);
          if (type === 'assistant' && deltas) {
            const streamed = deltas.takeMessageId();
            if (streamed !== undefined) message.uuid = streamed;
          }
          await session.managed.sink.write(message);
          parentUuid = message.uuid;
          return message.uuid;
        };
        const workspaceContext: HostedWorkspaceContextSlot = {
          read: () => session.workspaceContext,
          write: (context) => {
            session.workspaceContext = context;
          },
          invalidate: () => {
            session.workspaceContext = undefined;
          },
        };
        toolTurn = createToolTurn?.(
          harness,
          commit,
          (type, parts, model) =>
            Buffer.byteLength(
              JSON.stringify(messageRecord(type, parts, model)),
            ) <= HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
          workspaceContext,
        );
        if (resumeFromToolResults) {
          if (!toolTurn?.resumeCommittedResults)
            throw new HostedToolRecoveryRequiredError(
              'Tool turn is unavailable.',
            );
          try {
            await toolTurn.resumeCommittedResults(abort.signal);
          } catch (cause) {
            if (isRetryableWorkspaceAcquisition(cause)) throw cause;
            throw new HostedToolRecoveryRequiredError(cause);
          }
          onResumeReady?.();
        }
        let state: 'completed' | 'cancelled' | 'error' = 'completed';
        let stopReason = 'end_turn';
        let finalOutputCommitted = false;
        try {
          if (recoveredFinalOutput) {
            if (
              !resumeFromToolResults ||
              !toolTurn ||
              session.hooks ||
              !isDeepStrictEqual(projected.at(-1), recoveredFinalOutput)
            )
              throw new HostedToolRecoveryRequiredError(
                'Final output recovery is unavailable.',
              );
            await toolTurn.consumeResults();
          } else {
            const result = await runHostedHarnessTextTurn({
              sessionId,
              cwd,
              history,
              prompt: text,
              promptId,
              signal: abort.signal,
              modelScope,
              workspaceContext,
              ...(session.hooks ? { hooks: session.hooks } : {}),
              ...(toolTurn ? { toolTurn } : {}),
              ...(resumeFromToolResults ? { resumeFromToolResults } : {}),
              ...(deltas ? { textDeltas: deltas } : {}),
              ...(completeFinalOutput
                ? {
                    completeFinalOutput: async (
                      attempt: ManagedMainModelAttempt,
                      usage: unknown[],
                      parts: Part[],
                      model: string,
                    ) => {
                      const record = messageRecord('assistant', parts, model);
                      const streamed = deltas?.takeMessageId();
                      if (streamed !== undefined) record.uuid = streamed;
                      await completeFinalOutput(attempt, usage, record);
                      parentUuid = record.uuid;
                      finalOutputCommitted = true;
                    },
                  }
                : {}),
            });
            if (!finalOutputCommitted)
              await commit(
                'assistant',
                result.parts ?? [{ text: result.text }],
                result.model,
              );
          }
        } catch (cause) {
          if (
            cause instanceof HostedToolRecoveryRequiredError ||
            cause instanceof HostedMcpRecoveryRequiredError ||
            cause instanceof HostedHookRecoveryRequiredError
          )
            throw cause;
          const outcome = settledTurnOutcome(abort);
          state = outcome.state;
          stopReason = outcome.stopReason;
          if (state === 'error') {
            // The model layer surfaces any abort as a cancellation, so a
            // deadline expiry names the deadline, not the thrown cause.
            writeStderrLineSafe(
              stopReason === 'deadline_exceeded'
                ? `qwen serve: Hosted Harness turn ${promptId} exceeded its deadline.`
                : 'qwen serve: Hosted Harness turn ' +
                    promptId +
                    ' failed: ' +
                    String(cause),
            );
          }
        }
        await toolTurn?.finish();
        turnResult = createHostedChatRecord(
          session,
          sessionId,
          'system',
          null,
          {
            subtype: 'turn_result',
            systemPayload: { promptId, state, stopReason, endedAt: Date.now() },
          },
        );
        onTurnResult?.(turnResult);
        await session.managed.sink.write(turnResult);
        if (state === 'completed') await onCompleted?.();
      }),
  );
  // Session availability must not gate on publisher cleanup: the drain is
  // unbounded, and a stalled Session Store would otherwise leave the Session
  // permanently unavailable and undeletable. Each turn owns its publisher,
  // so a next turn shares no listener or capture state with this drain.
  await running.finally(() => {
    void toolTurn?.close().catch((cause: unknown) => {
      session.blocked = true;
      writeStderrLineSafe(
        'qwen serve: Hosted Shell publisher cleanup failed: ' + String(cause),
      );
    });
  });
  if (!turnResult) throw new Error('Hosted turn did not settle.');
  return turnResult;
}
