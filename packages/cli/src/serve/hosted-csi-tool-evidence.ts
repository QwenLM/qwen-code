/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { normalizeWorkspaceRelativePath } from '@qwen-code/qwen-code-core/managed-runtime/managed-workspace-relative-path.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Original CSI input is invalid.');
  return value as Record<string, unknown>;
}

export function acceptedCsiToolInput(
  call: ToolCallRequestInfo,
): Record<string, unknown> {
  const input = object(structuredClone(call.args));
  for (const value of Object.values(input)) {
    if (typeof value === 'string') encodeURIComponent(value);
  }
  const required =
    call.name === 'read_file'
      ? ['file_path']
      : call.name === 'write_file'
        ? ['file_path', 'content']
        : call.name === 'edit'
          ? ['file_path', 'old_string', 'new_string']
          : [];
  const optional =
    call.name === 'read_file'
      ? ['offset', 'limit']
      : call.name === 'edit'
        ? ['replace_all']
        : [];
  if (
    required.length === 0 ||
    required.some((key) => typeof input[key] !== 'string') ||
    Object.keys(input).some(
      (key) => ![...required, ...optional].includes(key),
    ) ||
    ['offset', 'limit'].some(
      (key) =>
        Object.hasOwn(input, key) &&
        (!Number.isSafeInteger(input[key]) ||
          (input[key] as number) > Number.MAX_SAFE_INTEGER - 1 ||
          (input[key] as number) < (key === 'limit' ? 1 : 0)),
    ) ||
    (Object.hasOwn(input, 'replace_all') &&
      typeof input['replace_all'] !== 'boolean')
  )
    throw new Error('CSI file input is invalid.');
  input['file_path'] = normalizeWorkspaceRelativePath(
    (input['file_path'] as string).trim(),
  );
  return input;
}

export async function publishHostedCsiReceipt(
  session: ManagedSession,
  executionCallId: string,
  outcome: Buffer,
) {
  const authority = session.authority;
  const outcomeRef = await session.resources.publish(
    'managed-tool-outcome',
    outcome,
  );
  await authority.appendExecutionEvent(
    {
      operation: 'recordToolResult',
      commandId: executionCallId,
      sessionKey: authority.sessionHeader.sessionKey,
      contentDigest: outcomeRef.digest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: `tool-receipt:${executionCallId}`,
      sessionKey: authority.sessionHeader.sessionKey,
      kind: 'tool.receipt',
      occurredAt: Date.now(),
      payload: {
        executionCallId,
        toolOutcomeRef: outcomeRef,
        resultRef: null,
        resources: [],
        historyRevision: sequence,
      },
    }),
    { class: 'trusted_entry' },
  );
  return outcomeRef;
}
