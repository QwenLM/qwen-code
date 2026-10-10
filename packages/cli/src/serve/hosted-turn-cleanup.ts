/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { parseHostedRecoveryResource } from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedWorkspaceBroker,
  hostedRuntimeSessionId,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import { readHostedFileHistory } from './hosted-file-history.js';

interface CleanupDescriptor {
  v: 1;
  sessionKey: ManagedSession['authority']['sessionHeader']['sessionKey'];
  promptId: string;
  runtimeSessionId: string;
  bindingId: string;
  generation: string;
  workspaceGeneration: string;
  fileHistoryTurnId: string;
}

async function commitCleanup(
  session: ManagedSession,
  cleanupId: string,
  descriptorRef: ManagedSessionDurableRef,
  state: 'owed' | 'confirmed',
): Promise<void> {
  const authority = session.authority;
  const activation = session.activation;
  await authority.appendExecutionEvent(
    {
      operation: 'hostedCleanup',
      commandId: `${cleanupId}:${state}`,
      sessionKey: authority.sessionHeader.sessionKey,
      contentDigest: createHash('sha256')
        .update(`${descriptorRef.digest}:${state}`)
        .digest('hex'),
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: `${cleanupId}:${state}`,
      sessionKey: authority.sessionHeader.sessionKey,
      kind: 'hosted.cleanup',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: activation.activationId,
        ...activation,
      },
      payload: { cleanupId, descriptorRef, state },
    }),
    { class: 'harness', activation },
  );
}

export async function oweHostedTurnCleanup(
  session: ManagedSession,
  promptId: string,
  broker: HostedWorkspaceBroker,
): Promise<void> {
  if (!broker.runtime) return;
  const cleanupId = `hosted-cleanup:${promptId}:${broker.runtimeSessionId}`;
  const existing = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'hosted.cleanup' &&
        event.payload['cleanupId'] === cleanupId,
    );
  if (existing) {
    if (existing.payload['state'] !== 'owed')
      throw new Error('Original Runtime owner was already released.');
    const descriptor = await readDescriptor(
      session,
      existing.payload['descriptorRef'],
    );
    if (
      !isDeepStrictEqual(
        {
          bindingId: descriptor.bindingId,
          generation: descriptor.generation,
          workspaceGeneration: descriptor.workspaceGeneration,
        },
        broker.runtime,
      )
    )
      throw new Error('Cleanup Runtime owner changed.');
    return;
  }
  const descriptor: CleanupDescriptor = {
    v: 1,
    sessionKey: session.authority.sessionHeader.sessionKey,
    promptId,
    runtimeSessionId: broker.runtimeSessionId,
    ...broker.runtime,
    fileHistoryTurnId: promptId,
  };
  const ref = await session.resources.publish(
    'hosted-turn-cleanup',
    Buffer.from(JSON.stringify(descriptor)),
  );
  await commitCleanup(session, cleanupId, ref, 'owed');
}

async function readDescriptor(
  session: ManagedSession,
  value: unknown,
): Promise<CleanupDescriptor> {
  const ref = assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'cleanup descriptor',
  );
  if (ref.kind !== 'hosted-turn-cleanup' || ref.schemaVersion !== 1)
    throw new Error('Invalid cleanup resource.');
  const body = parseHostedRecoveryResource(
    await session.resources.read(ref),
    session.authority.sessionHeader.sessionKey,
  );
  if (
    Object.keys(body).length !== 8 ||
    body['runtimeSessionId'] !==
      hostedRuntimeSessionId(body['promptId'] as string) ||
    body['fileHistoryTurnId'] !== body['promptId']
  )
    throw new Error('Invalid cleanup owner.');
  assertManagedSessionStableId(body['bindingId'], 'cleanup binding');
  for (const field of ['generation', 'workspaceGeneration'])
    if (
      typeof body[field] !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(body[field] as string) ||
      BigInt(body[field] as string) > 2n ** 63n - 1n
    )
      throw new Error('Invalid cleanup generation.');
  return body as unknown as CleanupDescriptor;
}

export function hasHostedCleanupDebt(session: ManagedSession): boolean {
  const states = new Map<string, unknown>();
  for (const event of session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  ))
    if (event.kind === 'hosted.cleanup')
      states.set(event.payload['cleanupId'] as string, event.payload['state']);
  return [...states.values()].some((state) => state === 'owed');
}

export async function reconcileHostedTurnCleanup(
  session: ManagedSession,
  options: HostedWorkspaceBrokerOptions,
  promptId?: string,
): Promise<Map<string, 'owed' | 'confirmed'>> {
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  const latest = new Map<string, (typeof events)[number]>();
  const states = new Map<string, 'owed' | 'confirmed'>();
  for (const event of events)
    if (event.kind === 'hosted.cleanup')
      latest.set(event.payload['cleanupId'] as string, event);
  for (const [cleanupId, event] of latest) {
    const descriptor = await readDescriptor(
      session,
      event.payload['descriptorRef'],
    );
    if (promptId && descriptor.promptId !== promptId) continue;
    const state = event.payload['state'] as 'owed' | 'confirmed';
    states.set(descriptor.promptId, state);
    if (state !== 'owed') continue;
    if (
      !events.some(
        (item) =>
          item.kind === 'turn.settled' &&
          item.payload['turnId'] === descriptor.promptId,
      )
    )
      continue;
    const history = await readHostedFileHistory(session);
    if (
      history?.pendingUndo ||
      history?.pendingTurn === descriptor.fileHistoryTurnId
    )
      throw new Error('Original file history marker is still owed.');
    const broker = new HostedWorkspaceBroker(
      options,
      descriptor.sessionKey,
      descriptor.runtimeSessionId,
    );
    await broker.release({
      bindingId: descriptor.bindingId,
      generation: descriptor.generation,
    });
    await commitCleanup(
      session,
      cleanupId,
      assertManagedSessionDurableRef(
        event.payload['descriptorRef'],
        'cleanup descriptor',
      ),
      'confirmed',
    );
    states.set(descriptor.promptId, 'confirmed');
  }
  return states;
}
