/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  runHostedHarnessTextTurn,
  type HostedHarnessModelResult,
} from './hosted-harness-model.js';
import { HostedTextDeltaStream } from './hosted-text-deltas.js';

export interface HostedCsiTextSession {
  managed: ManagedSession;
  cwd: string;
}

export async function runHostedCsiTextTurn(
  session: HostedCsiTextSession,
  promptId: string,
  text: string,
  abort: AbortController,
): Promise<ChatRecord> {
  const { managed, cwd } = session;
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
            settled.has(entry.daemonPromptId) &&
            !(
              entry.type === 'user' &&
              settled.get(entry.daemonPromptId) !== 'completed'
            ),
        );
        const user = record('user', projected.at(-1)?.uuid ?? null, {
          daemonPromptId: promptId,
          message: { role: 'user', parts: [{ text }] },
        });
        await managed.sink.write(user);
        const deltas = new HostedTextDeltaStream(managed, promptId);
        let state: 'completed' | 'error' = 'completed';
        let stopReason = 'end_turn';
        let result: HostedHarnessModelResult | undefined;
        try {
          result = await runHostedHarnessTextTurn({
            sessionId,
            cwd,
            history,
            prompt: text,
            promptId,
            signal: abort.signal,
            modelScope,
            textDeltas: deltas,
          });
        } catch (cause) {
          if (cause instanceof ManagedSessionRecordError) throw cause;
          state = 'error';
          stopReason = state;
          if (!abort.signal.aborted)
            writeStderrLineSafe(
              `qwen serve: Private CSI text turn ${promptId} failed: ${String(cause)}`,
            );
        }
        if (result) {
          const assistant = record('assistant', user.uuid, {
            daemonPromptId: promptId,
            model: result.model,
            message: {
              role: 'model',
              parts: result.parts ?? [{ text: result.text }],
            },
          });
          assistant.uuid = deltas.takeMessageId() ?? assistant.uuid;
          await managed.sink.write(assistant);
        }
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
