/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface HostedModelSelection {
  modelId: string;
  revision: number;
}

export function parseHostedModelSelection(
  value: unknown,
): HostedModelSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Hosted model selection.');
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !== 2 ||
    typeof selection['modelId'] !== 'string' ||
    !selection['modelId'].trim() ||
    Buffer.byteLength(selection['modelId']) > 512 ||
    /[\p{Cc}]/u.test(selection['modelId']) ||
    typeof selection['revision'] !== 'number' ||
    !Number.isSafeInteger(selection['revision']) ||
    selection['revision'] < 1
  )
    throw new Error('Invalid Hosted model selection.');
  return {
    modelId: selection['modelId'],
    revision: selection['revision'],
  };
}

export async function readHostedTurnModelSelection(
  session: ManagedSession,
  promptId: string,
): Promise<HostedModelSelection | undefined> {
  const accepted = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['inputId'] === promptId,
    );
  if (accepted?.payload['source'] !== 'hosted-harness') return undefined;
  const rawRef = accepted?.payload['admissionRef'];
  if (rawRef === undefined) return undefined;
  const ref = assertManagedSessionDurableRef(
    rawRef,
    'model selection admission',
  );
  if (
    ref.kind !== 'managed-admission' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > 64 * 1024
  )
    throw new Error('Invalid Hosted model selection admission.');
  const admission: unknown = JSON.parse(
    (await session.resources.read(ref)).toString('utf8'),
  );
  if (!admission || typeof admission !== 'object' || Array.isArray(admission))
    throw new Error('Invalid Hosted model selection admission.');
  const fields = admission as Record<string, unknown>;
  if (fields['modelSelection'] === undefined) return undefined;
  if (fields['promptId'] !== promptId)
    throw new Error('Hosted model selection belongs to another input.');
  return parseHostedModelSelection(fields['modelSelection']);
}
