/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertManagedSessionDurableRef,
  assertManagedSessionKey,
  assertManagedSessionStableId,
  parseManagedSessionRecordJson,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
  type ManagedSessionKey,
} from './managed-session-records.js';

export const HOSTED_RECOVERY_RESOURCE_KINDS = new Set([
  'hosted-approval-continuation',
  'hosted-model-request',
  'hosted-turn-cleanup',
]);

export function parseHostedRecoveryResource(
  bytes: Buffer,
  expectedKey?: ManagedSessionKey,
): Record<string, ManagedSessionJsonValue> {
  const value = parseManagedSessionRecordJson(
    bytes.toString('utf8'),
    64 * 1024,
  );
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value['v'] !== 1
  )
    throw new ManagedSessionRecordError('Invalid Hosted recovery resource.');
  const key = assertManagedSessionKey(
    value['sessionKey'],
    'Hosted recovery sessionKey',
  );
  assertManagedSessionStableId(value['promptId'], 'Hosted recovery promptId');
  if (
    expectedKey &&
    (key.tenantId !== expectedKey.tenantId ||
      key.workspaceId !== expectedKey.workspaceId ||
      key.sessionId !== expectedKey.sessionId)
  )
    throw new ManagedSessionRecordError(
      'Hosted recovery resource names another Session.',
    );
  return value;
}

export function hostedRecoveryReferences(
  value: unknown,
): ManagedSessionDurableRef[] {
  const refs = new Map<string, ManagedSessionDurableRef>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const body = value as Record<string, unknown>;
  const pending: unknown[] = [
    'definitionRef',
    'rootSnapshotRef',
    'assistantRef',
    'inputRef',
    'continuationRef',
  ].flatMap((field) => (body[field] ? [body[field]] : []));
  if (Array.isArray(body['calls']))
    for (const call of body['calls']) {
      if (!call || typeof call !== 'object') continue;
      const member = call as Record<string, unknown>;
      pending.push(member['inputRef'], member['definitionRef']);
    }
  for (const item of pending) {
    const ref = assertManagedSessionDurableRef(
      item as ManagedSessionJsonValue,
      'Hosted recovery reference',
    );
    const previous = refs.get(ref.resourceId);
    if (
      previous &&
      (previous.kind !== ref.kind ||
        previous.schemaVersion !== ref.schemaVersion ||
        previous.byteLength !== ref.byteLength ||
        previous.digest !== ref.digest)
    )
      throw new ManagedSessionRecordError(
        'Hosted recovery references conflict.',
      );
    refs.set(ref.resourceId, ref);
  }
  return [...refs.values()];
}
