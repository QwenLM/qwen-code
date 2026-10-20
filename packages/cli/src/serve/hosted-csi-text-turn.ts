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
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  runHostedHarnessTextTurn,
  type HostedHarnessModelResult,
} from './hosted-harness-model.js';
import { HostedTextDeltaStream } from './hosted-text-deltas.js';
import {
  HostedCsiToolTurn,
  type HostedCsiTurnCommit,
} from './hosted-csi-tool-turn.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';

export interface HostedCsiTextSession {
  managed: ManagedSession;
  cwd: string;
  files?: {
    broker: HostedWorkspaceBrokerOptions;
    runtime: { bindingId: string; generation: string };
  };
}

export async function runHostedCsiTextTurn(
  session: HostedCsiTextSession,
  promptId: string,
  text: string,
  abort: AbortController,
  resumeFromToolResults?: readonly Part[],
  recoveredFinalOutput?: ChatRecord,
): Promise<ChatRecord> {
  const { managed, cwd, files } = session;
  const authority = managed.authority;
  const sessionId = authority.sessionHeader.sessionKey.sessionId;
  const harness = createManagedHarnessHandle(managed);
  const record = (
    type: ChatRecord['type'],
    parentUuid: string | null,
    fields: Partial<ChatRecord>,
  ): ChatRecord => ({
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd,
    version: 'hosted-harness/1',
    ...fields,
  });
  let turnResult: ChatRecord | undefined;
  await new ManagedHookActivationController(managed).runTurn(
    promptId,
    async (modelScope) =>
      harness.run(async () => {
        const projected = await managed.sink.project();
        const settled = new Map(
          authority
            .eventsInSequenceRange(1, authority.committedSequence)
            .filter((event) => event.kind === 'turn.settled')
            .map((event) => [
              event.payload['turnId'],
              event.payload['outcome'],
            ]),
        );
        const history = projected.filter(
          (entry) =>
            (resumeFromToolResults !== undefined &&
              entry.daemonPromptId === promptId) ||
            (settled.has(entry.daemonPromptId) &&
              !(
                entry.type === 'user' &&
                settled.get(entry.daemonPromptId) !== 'completed'
              )),
        );
        let parentUuid = projected.at(-1)?.uuid ?? null;
        if (resumeFromToolResults === undefined) {
          const user = record('user', parentUuid, {
            daemonPromptId: promptId,
            message: { role: 'user', parts: [{ text }] },
          });
          await managed.sink.write(user);
          parentUuid = user.uuid;
        }
        const deltas = new HostedTextDeltaStream(managed, promptId);
        const messageRecord = (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: Pick<ChatRecord, 'uuid' | 'timestamp'>,
        ) =>
          record(type, parentUuid, {
            daemonPromptId: promptId,
            model,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
            ...identity,
          });
        const fitsInline = (message: ChatRecord) =>
          Buffer.byteLength(JSON.stringify(message)) <=
          HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
        const commit: HostedCsiTurnCommit = async (
          type,
          parts,
          model,
          identity,
        ) => {
          const message = messageRecord(type, parts, model, identity);
          if (type === 'assistant')
            message.uuid = deltas.takeMessageId() ?? message.uuid;
          await managed.sink.write(message);
          parentUuid = message.uuid;
          return message.uuid;
        };
        const toolTurn = files
          ? new HostedCsiToolTurn(
              managed,
              files.broker,
              files.runtime,
              promptId,
              commit,
              harness,
              (type, parts, model) =>
                fitsInline(messageRecord(type, parts, model)),
            )
          : undefined;
        if (resumeFromToolResults !== undefined) {
          if (!toolTurn)
            throw new HostedToolRecoveryRequiredError(
              'CSI file recovery is unavailable.',
            );
          await toolTurn.resumeCommittedResults(abort.signal);
        }
        let state: 'completed' | 'error' = 'completed';
        let stopReason = 'end_turn';
        let result: HostedHarnessModelResult | undefined;
        let finalOutputCommitted = false;
        try {
          if (recoveredFinalOutput) {
            if (
              resumeFromToolResults === undefined ||
              !toolTurn ||
              !isDeepStrictEqual(projected.at(-1), recoveredFinalOutput)
            )
              throw new HostedToolRecoveryRequiredError(
                'Final CSI output recovery is unavailable.',
              );
            await toolTurn.consumeResults();
          } else {
            result = await runHostedHarnessTextTurn({
              sessionId,
              cwd,
              history,
              prompt: text,
              promptId,
              signal: abort.signal,
              modelScope,
              textDeltas: deltas,
              ...(resumeFromToolResults !== undefined
                ? { resumeFromToolResults }
                : {}),
              ...(toolTurn
                ? {
                    toolTurn,
                    completeFinalOutput: async (
                      attempt,
                      usage,
                      parts,
                      model,
                    ) => {
                      const message = messageRecord('assistant', parts, model);
                      message.uuid = deltas.takeMessageId() ?? message.uuid;
                      await attempt(true, usage, message);
                      parentUuid = message.uuid;
                      finalOutputCommitted = true;
                    },
                  }
                : {}),
            });
          }
        } catch (cause) {
          if (
            cause instanceof ManagedSessionRecordError ||
            cause instanceof HostedToolRecoveryRequiredError
          )
            throw cause;
          state = 'error';
          stopReason = state;
          if (!abort.signal.aborted)
            writeStderrLineSafe(
              `qwen serve: Private CSI text turn ${promptId} failed: ${String(cause)}`,
            );
        }
        if (result && !finalOutputCommitted)
          await commit(
            'assistant',
            result.parts ?? [{ text: result.text }],
            result.model,
          );
        await toolTurn?.finish();
        turnResult = record('system', null, {
          subtype: 'turn_result',
          systemPayload: { promptId, state, stopReason, endedAt: Date.now() },
        });
        await managed.sink.write(turnResult);
      }),
  );
  if (!turnResult) throw new Error('Private CSI text turn did not settle.');
  return turnResult;
}
