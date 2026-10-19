/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  normalizeWorkspaceRelativePath,
  WORKSPACE_ROOT,
} from './managed-workspace-binding.js';
import type { Part } from '@google/genai';
import {
  convertToFunctionResponse,
  convertToFunctionErrorResponse,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

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
    // Reject lone surrogates before serializing input for the native worker.
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
  if (input['file_path'] === WORKSPACE_ROOT)
    throw new Error('CSI file input must name a file.');
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

export function convertHostedCsiToolResult(
  toolName: string,
  callId: string,
  result: Awaited<ReturnType<HostedWorkspaceBroker['execute']>>,
): Part[] {
  const responseParts = result.responseParts as Part[];
  const error = result.error;
  if (
    Object.keys(result).some(
      (key) => !['executionStatus', 'responseParts', 'error'].includes(key),
    ) ||
    !['success', 'error'].includes(result.executionStatus) ||
    (error !== undefined &&
      (!error ||
        typeof error !== 'object' ||
        Array.isArray(error) ||
        Object.keys(error).some((key) => !['message', 'type'].includes(key)) ||
        typeof error.message !== 'string' ||
        !error.message ||
        (Object.hasOwn(error, 'type') &&
          (typeof error.type !== 'string' || !error.type)))) ||
    !Array.isArray(responseParts) ||
    responseParts.some((part: unknown) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return true;
      const value = part as Record<string, unknown>;
      if (Object.hasOwn(value, 'text'))
        return (
          typeof value['text'] !== 'string' ||
          Object.keys(value).some((key) => !['text', 'type'].includes(key)) ||
          (Object.hasOwn(value, 'type') && value['type'] !== 'text')
        );
      const field = Object.hasOwn(value, 'inlineData')
        ? 'inlineData'
        : 'fileData';
      const content = value[field] as Record<string, unknown> | undefined;
      const data = field === 'inlineData' ? 'data' : 'fileUri';
      return (
        Object.keys(value).length !== 1 ||
        !content ||
        typeof content !== 'object' ||
        Array.isArray(content) ||
        Object.keys(content).sort().join(',') !==
          [data, 'mimeType'].sort().join(',') ||
        typeof content['mimeType'] !== 'string' ||
        !content['mimeType'] ||
        content['mimeType'].length > 4096 ||
        typeof content[data] !== 'string' ||
        !content[data] ||
        content[data].length > 4096
      );
    })
  )
    throw new Error('Runtime returned an unsupported tool result.');
  const converted =
    result.executionStatus === 'success'
      ? convertToFunctionResponse(toolName, callId, responseParts)
      : convertToFunctionErrorResponse(
          toolName,
          callId,
          responseParts,
          result.error?.message ?? `Runtime tool ${result.executionStatus}.`,
        );
  const response = converted[0]?.functionResponse;
  if (
    !response ||
    converted.length !== 1 ||
    response.id !== callId ||
    response.name !== toolName
  )
    throw new Error('Runtime result cannot be represented durably.');
  response.response = {
    ...response.response,
    executionStatus: result.executionStatus,
    ...(result.error ? { runtimeError: result.error } : {}),
  };
  return converted;
}
