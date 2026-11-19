/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { parseHostedRecoveryResource } from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  MANAGED_SESSION_LIMITS,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
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

export interface HostedCleanupHold {
  cleanupId: string;
  descriptorRef: ManagedSessionDurableRef;
  runtimeSessionId: string;
}

export interface HostedCleanupResult {
  states: Map<string, 'owed' | 'confirmed'>;
  held: Map<string, HostedCleanupHold>;
}

function cleanupIdentity(promptId: string, runtimeSessionId: string) {
  const originalId = `hosted-cleanup:${promptId}:${runtimeSessionId}`;
  const cleanupId =
    Buffer.byteLength(`${originalId}:confirmed`) >
    MANAGED_SESSION_LIMITS.maxIdBytes
      ? `hosted-cleanup:${createHash('sha256').update(originalId).digest('hex')}`
      : originalId;
  return { originalId, cleanupId };
}

async function commitCleanup(
  session: ManagedSession,
  cleanupId: string,
  descriptorRef: ManagedSessionDurableRef,
  state: 'owed' | 'confirmed',
): Promise<void> {
  const authority = session.authority;
  const activation = session.activation;
  const rawEventId = `${cleanupId}:${state}`;
  const eventId =
    Buffer.byteLength(rawEventId) <= MANAGED_SESSION_LIMITS.maxIdBytes
      ? rawEventId
      : `hosted-cleanup:${createHash('sha256').update(rawEventId).digest('hex')}`;
  await authority.appendExecutionEvent(
    {
      operation: 'hostedCleanup',
      commandId: eventId,
      sessionKey: authority.sessionHeader.sessionKey,
      contentDigest: createHash('sha256')
        .update(`${descriptorRef.digest}:${state}`)
        .digest('hex'),
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId,
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
  const { originalId, cleanupId } = cleanupIdentity(
    promptId,
    broker.runtimeSessionId,
  );
  const existing = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'hosted.cleanup' &&
        (event.payload['cleanupId'] === cleanupId ||
          event.payload['cleanupId'] === originalId),
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

export async function confirmReplacedHostedTurnOwner(
  session: ManagedSession,
  promptId: string,
  broker: HostedWorkspaceBroker,
  options: HostedWorkspaceBrokerOptions,
): Promise<boolean> {
  if (!broker.runtime) return false;
  const { originalId, cleanupId } = cleanupIdentity(
    promptId,
    broker.runtimeSessionId,
  );
  const existing = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'hosted.cleanup' &&
        [originalId, cleanupId].includes(event.payload['cleanupId'] as string),
    );
  if (existing?.payload['state'] !== 'owed') return false;
  const descriptor = await readDescriptor(
    session,
    existing.payload['descriptorRef'],
  );
  if (
    descriptor.promptId !== promptId ||
    descriptor.runtimeSessionId !== broker.runtimeSessionId
  )
    throw new Error('Invalid cleanup owner.');
  if (descriptor.workspaceGeneration !== broker.runtime.workspaceGeneration)
    throw new Error('Original Workspace generation changed.');
  if (
    descriptor.bindingId === broker.runtime.bindingId &&
    descriptor.generation === broker.runtime.generation &&
    descriptor.workspaceGeneration === broker.runtime.workspaceGeneration
  )
    return false;
  await new HostedWorkspaceBroker(
    options,
    descriptor.sessionKey,
    descriptor.runtimeSessionId,
  ).release({
    bindingId: descriptor.bindingId,
    generation: descriptor.generation,
  });
  return true;
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

async function hasBackgroundHoldEvidence(
  session: ManagedSession,
  descriptor: CleanupDescriptor,
): Promise<boolean> {
  const authority = session.authority;
  const sequence = authority.committedSequence;
  const intents = new Map(
    authority
      .eventsInSequenceRange(1, sequence)
      .filter((event) => event.kind === 'tool.intent')
      .map((event) => [
        event.payload['executionCallId'],
        event.payload['argsRef'],
      ]),
  );
  let held = false;
  for (const domain of ['child_run', 'monitor_run'] as const) {
    for (const entry of authority.extensionRecordsInDomain(domain)) {
      const record =
        domain === 'child_run'
          ? parseChildRun(entry.record)
          : parseMonitorRun(entry.record);
      if ('kind' in record && record.kind !== 'shell') continue;
      const run = record.run;
      if (['settled', 'not_started_proven'].includes(run.execution ?? ''))
        continue;
      const inputRef = intents.get(run.executionCallId);
      if (!inputRef) return false;
      const ref = assertManagedSessionDurableRef(inputRef, 'background owner');
      if (ref.kind !== 'managed-tool-input') return false;
      const input = JSON.parse(
        (await session.resources.read(ref)).toString('utf8'),
      ) as {
        harnessSessionId?: unknown;
        runtimeSessionId?: unknown;
      };
      if (
        input.harnessSessionId !== descriptor.sessionKey.sessionId ||
        typeof input.runtimeSessionId !== 'string'
      )
        return false;
      if (input.runtimeSessionId !== descriptor.runtimeSessionId) continue;
      if (
        !run.runtime ||
        run.runtime.runtimeBindingId !== descriptor.bindingId ||
        run.runtime.generation !== descriptor.generation ||
        !record.startReceiptRef ||
        !['running', 'waiting'].includes(run.state) ||
        run.execution !== 'running_attached'
      )
        return false;
      held = true;
    }
  }
  return held && authority.committedSequence === sequence;
}

export async function hasBlockingHostedCleanupDebt(
  session: ManagedSession,
  holds?: ReadonlyMap<string, HostedCleanupHold>,
): Promise<boolean> {
  const sequence = session.authority.committedSequence;
  const latest = new Map(
    session.authority
      .eventsInSequenceRange(1, sequence)
      .filter((event) => event.kind === 'hosted.cleanup')
      .map((event) => [event.payload['cleanupId'], event]),
  );
  for (const event of latest.values()) {
    if (event.payload['state'] !== 'owed') continue;
    const descriptor = await readDescriptor(
      session,
      event.payload['descriptorRef'],
    );
    const hold = holds?.get(descriptor.promptId);
    if (
      !hold ||
      hold.cleanupId !== event.payload['cleanupId'] ||
      hold.runtimeSessionId !== descriptor.runtimeSessionId ||
      !isDeepStrictEqual(hold.descriptorRef, event.payload['descriptorRef']) ||
      !(await hasBackgroundHoldEvidence(session, descriptor))
    )
      return true;
  }
  return session.authority.committedSequence !== sequence;
}

export async function reconcileHostedTurnCleanup(
  session: ManagedSession,
  options: HostedWorkspaceBrokerOptions,
  promptId?: string,
  drain = false,
): Promise<HostedCleanupResult> {
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  const latest = new Map<string, (typeof events)[number]>();
  const states = new Map<string, 'owed' | 'confirmed'>();
  const held = new Map<string, HostedCleanupHold>();
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
    try {
      await broker.release({
        bindingId: descriptor.bindingId,
        generation: descriptor.generation,
        ...(drain ? { drain: true } : {}),
      });
    } catch (cause) {
      if (
        drain ||
        !(cause instanceof HostedWorkspaceBrokerRejection) ||
        cause.status !== 409 ||
        cause.code !== 'runtime_session_held' ||
        !(await hasBackgroundHoldEvidence(session, descriptor))
      )
        throw cause;
      held.set(descriptor.promptId, {
        cleanupId,
        descriptorRef: assertManagedSessionDurableRef(
          event.payload['descriptorRef'],
          'cleanup descriptor',
        ),
        runtimeSessionId: descriptor.runtimeSessionId,
      });
      continue;
    }
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
  return { states, held };
}
