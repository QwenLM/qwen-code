/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HostedApprovalMode,
  HostedApprovalSettings,
} from './hosted-tool-approval.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface HostedApprovalSelection {
  mode: HostedApprovalMode;
  revision: number;
}

export function parseHostedApprovalSelection(
  value: unknown,
): HostedApprovalSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Hosted approval selection.');
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !== 2 ||
    (selection['mode'] !== 'default' &&
      selection['mode'] !== 'auto-edit' &&
      selection['mode'] !== 'yolo') ||
    typeof selection['revision'] !== 'number' ||
    !Number.isSafeInteger(selection['revision']) ||
    selection['revision'] < 0
  )
    throw new Error('Invalid Hosted approval selection.');
  return {
    mode: selection['mode'] as HostedApprovalMode,
    revision: selection['revision'],
  };
}

export async function readHostedTurnApprovalSelection(
  session: ManagedSession,
  promptId: string,
): Promise<HostedApprovalSelection | undefined> {
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
    'approval selection admission',
  );
  if (
    ref.kind !== 'managed-admission' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > 64 * 1024
  )
    throw new Error('Invalid Hosted approval selection admission.');
  const admission: unknown = JSON.parse(
    (await session.resources.read(ref)).toString('utf8'),
  );
  if (!admission || typeof admission !== 'object' || Array.isArray(admission))
    throw new Error('Invalid Hosted approval selection admission.');
  const fields = admission as Record<string, unknown>;
  if (fields['approvalSelection'] === undefined) return undefined;
  if (fields['promptId'] !== promptId)
    throw new Error('Hosted approval selection belongs to another input.');
  return parseHostedApprovalSelection(fields['approvalSelection']);
}

export async function hostedTurnApproval(
  session: ManagedSession,
  promptId: string,
  initial: HostedApprovalSettings | undefined,
): Promise<HostedApprovalSettings | undefined> {
  const selection = await readHostedTurnApprovalSelection(session, promptId);
  if (!selection) return initial;
  if (!initial || (selection.revision === 0 && selection.mode !== initial.mode))
    throw new Error(
      'Hosted approval selection conflicts with the Session definition.',
    );
  return { ...initial, mode: selection.mode };
}
