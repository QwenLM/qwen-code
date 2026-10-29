/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  assertManagedSessionDurableRef,
  isChildNotificationSource,
  ManagedSessionRecordError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { MonitorWakeTransientReadError } from './hosted-monitor-wake.js';

export function hostedWakeContinuationId(interruptedTurnId: string): string {
  return `wake-recovery:${createHash('sha256').update(interruptedTurnId).digest('hex')}`;
}

export function isHostedWakeContinuationId(turnId: string): boolean {
  return /^wake-recovery:[0-9a-f]{64}$/.test(turnId);
}

function acceptedInput(session: ManagedSession, turnId: string) {
  return session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find(
      (event) =>
        event.kind === 'input.accepted' && event.payload['turnId'] === turnId,
    );
}

function canContinue(source: unknown): boolean {
  return source === 'monitor' || isChildNotificationSource(source);
}

async function inputBody(session: ManagedSession, turnId: string) {
  const input = acceptedInput(session, turnId);
  const ref = assertManagedSessionDurableRef(
    input?.payload['contentRef'],
    'wake continuation input',
  );
  if (ref.kind !== 'managed-input')
    throw new ManagedSessionRecordError('Wake continuation has no input.');
  let bytes: Buffer;
  try {
    bytes = await session.resources.read(ref);
  } catch (cause) {
    throw new MonitorWakeTransientReadError(String(cause), { cause });
  }
  const body: unknown = JSON.parse(bytes.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ManagedSessionRecordError('Invalid wake continuation input.');
  const fields = body as Record<string, unknown>;
  if (typeof fields['text'] !== 'string')
    throw new ManagedSessionRecordError('Wake continuation has no text.');
  return fields;
}

async function continuationBody(session: ManagedSession, turnId: string) {
  const body = await inputBody(session, turnId);
  const interrupted = body['interruptedTurnId'];
  const notification = body['notificationTurnId'];
  const source = acceptedInput(session, turnId)?.payload['source'];
  if (
    typeof interrupted !== 'string' ||
    hostedWakeContinuationId(interrupted) !== turnId ||
    typeof notification !== 'string' ||
    isHostedWakeContinuationId(notification) ||
    !canContinue(source) ||
    acceptedInput(session, notification)?.payload['source'] !== source
  )
    throw new ManagedSessionRecordError('Invalid wake continuation identity.');
  return { text: body['text'] as string, notificationTurnId: notification };
}

/** Admit before the old settle: a crash between them must leave work owed. */
export async function enqueueHostedWakeContinuation(
  session: ManagedSession,
  interruptedTurnId: string,
): Promise<string | undefined> {
  const input = acceptedInput(session, interruptedTurnId);
  if (!canContinue(input?.payload['source'])) return undefined;
  const turnId = hostedWakeContinuationId(interruptedTurnId);
  if (acceptedInput(session, turnId)) return turnId;
  const notificationTurnId = isHostedWakeContinuationId(interruptedTurnId)
    ? (await continuationBody(session, interruptedTurnId)).notificationTurnId
    : interruptedTurnId;
  const body = Buffer.from(
    JSON.stringify({
      text:
        `Continue the interrupted background notification ${notificationTurnId}. ` +
        'Its previous attempt has been settled. Read the committed history and recovered tool results before choosing the next action. ' +
        'Do not repeat completed operations. An unknown outcome is not proof that an operation did not happen; inspect durable state before retrying.',
      interruptedTurnId,
      notificationTurnId,
    }),
  );
  const contentRef = await session.resources.publish('managed-input', body);
  const admissionRef = await session.resources.publish(
    'managed-admission',
    Buffer.from('{}'),
  );
  await session.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: turnId,
      sessionKey: session.authority.sessionHeader.sessionKey,
      contentDigest: contentRef.digest,
    },
    {
      inputId: turnId,
      turnId,
      source: input!.payload['source'] as string,
      contentRef,
      admissionRef,
      deadline: null,
      wakeReason: 'input',
    },
  );
  return turnId;
}

export async function readHostedWakeContinuation(
  session: ManagedSession,
  turnId: string,
): Promise<{ text: string; notificationTurnId: string }> {
  const continuation = await continuationBody(session, turnId);
  const notification = await inputBody(
    session,
    continuation.notificationTurnId,
  );
  return {
    text: `${continuation.text}\n\nOriginal notification:\n${notification['text']}`,
    notificationTurnId: continuation.notificationTurnId,
  };
}
