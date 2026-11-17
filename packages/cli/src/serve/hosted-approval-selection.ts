/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import {
  parseManagedPermissionRules,
  nonEmptyManagedPermissionRules,
  type ManagedPermissionRules,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-permission-rules.js';
import type {
  HostedApprovalMode,
  HostedApprovalSettings,
} from './hosted-tool-approval.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionApprovalSelection } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';

export interface HostedApprovalSelection {
  mode: HostedApprovalMode;
  revision: number;
  planMode?: true;
  permissionRules?: ManagedPermissionRules;
}

export function parseHostedApprovalSelection(
  value: unknown,
): HostedApprovalSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Hosted approval selection.');
  const selection = value as Record<string, unknown>;
  if (
    Object.keys(selection).length !==
      (selection['planMode'] === true ? 3 : 2) +
        (selection['permissionRules'] === undefined ? 0 : 1) ||
    (Object.hasOwn(selection, 'planMode') && selection['planMode'] !== true) ||
    (selection['mode'] !== 'default' &&
      selection['mode'] !== 'auto-edit' &&
      selection['mode'] !== 'yolo' &&
      selection['mode'] !== 'auto') ||
    typeof selection['revision'] !== 'number' ||
    !Number.isSafeInteger(selection['revision']) ||
    selection['revision'] < (selection['planMode'] === true ? 1 : 0)
  )
    throw new Error('Invalid Hosted approval selection.');
  const permissionRules =
    selection['permissionRules'] === undefined
      ? undefined
      : nonEmptyManagedPermissionRules(
          parseManagedPermissionRules(selection['permissionRules']),
        );
  if (
    selection['revision'] === 0 &&
    (selection['mode'] === 'auto' || permissionRules)
  )
    throw new Error('Invalid Hosted approval selection.');
  return {
    mode: selection['mode'] as HostedApprovalMode,
    revision: selection['revision'],
    ...(selection['planMode'] === true ? { planMode: true as const } : {}),
    ...(permissionRules ? { permissionRules } : {}),
  };
}

export async function readHostedTurnApprovalSelection(
  session: ManagedSession,
  promptId: string,
  readWakeSelection?: () => Promise<
    ManagedSessionApprovalSelection | undefined
  >,
): Promise<HostedApprovalSelection | undefined> {
  const accepted = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['inputId'] === promptId,
    );
  if (accepted?.payload['source'] !== 'hosted-harness') {
    if (!accepted || !readWakeSelection) return undefined;
    const selection = parseHostedApprovalSelection(await readWakeSelection());
    // A wake whose store holds no selection has nothing to pin: fall back to
    // the Session's own approval settings, exactly as a hosted-harness input
    // without an admission does. Only a malformed stored selection is an
    // error, and parseHostedApprovalSelection raises that itself.
    if (!selection) return undefined;
    return selection;
  }
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
  pinned?: HostedApprovalSelection,
): Promise<HostedApprovalSettings | undefined> {
  const selection =
    pinned ?? (await readHostedTurnApprovalSelection(session, promptId));
  if (!selection) return initial;
  if (
    !initial ||
    (selection.revision === 0 &&
      (selection.mode !== initial.mode ||
        !isDeepStrictEqual(selection.permissionRules, initial.permissionRules)))
  )
    throw new Error(
      'Hosted approval selection conflicts with the Session definition.',
    );
  const permissionRules = nonEmptyManagedPermissionRules(
    selection.permissionRules,
  );
  return {
    mode: selection.mode,
    timeoutMs: initial.timeoutMs,
    ...(permissionRules ? { permissionRules } : {}),
  };
}

export function createHostedLiveApprovalReader(
  initial: HostedApprovalSettings,
  admission: HostedApprovalSelection | undefined,
  query: () => Promise<ManagedSessionApprovalSelection | undefined>,
): () => Promise<HostedApprovalSettings> {
  let previous: ManagedSessionApprovalSelection = admission ?? {
    mode: initial.mode,
    revision: 0,
    ...(initial.permissionRules
      ? { permissionRules: initial.permissionRules }
      : {}),
  };
  let tail = Promise.resolve();
  return () => {
    const work = tail.then(async () => {
      const selection = parseHostedApprovalSelection(await query());
      if (
        !selection ||
        selection.revision < previous.revision ||
        !isDeepStrictEqual(
          selection.permissionRules,
          initial.permissionRules,
        ) ||
        (selection.revision === previous.revision &&
          (selection.mode !== previous.mode ||
            !isDeepStrictEqual(
              selection.permissionRules,
              previous.permissionRules,
            )))
      )
        throw new Error(
          'Hosted live approval selection is missing or regressed.',
        );
      previous = selection;
      const permissionRules = nonEmptyManagedPermissionRules(
        selection.permissionRules,
      );
      return {
        mode: selection.mode,
        timeoutMs: initial.timeoutMs,
        ...(permissionRules ? { permissionRules } : {}),
      };
    });
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
}
