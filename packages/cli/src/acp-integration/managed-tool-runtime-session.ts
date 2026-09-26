/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createBuiltinManagedToolRuntime,
  type ManagedToolRuntime,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  managedToolDigest,
  parseManagedToolCallIdentity,
  parseManagedToolContentModification,
  parseManagedToolMediaContext,
  parseManagedToolInvocationReference,
  parseManagedToolConfirmationPayload,
  ManagedToolProtocolError,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  MANAGED_TOOL_FILE_HISTORY_MAX_BYTES,
  parseManagedToolFileHistoryBinding,
  parseManagedToolFileHistoryPromptId,
  parseManagedToolFileHistoryState,
} from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import type { ManagedToolV2Client } from '@qwen-code/acp-bridge/bridgeTypes';
import { parseCallerSuppliedSessionId } from '../config/session-id.js';
import { managedToolResponseMediaBytes } from './managed-tool-media.js';

const METHODS = SERVE_CONTROL_EXT_METHODS;
const methodKeys = new Map<string, readonly string[]>([
  [METHODS.sessionManagedToolV2BindHistory, ['sessionId', 'binding']],
  [METHODS.sessionManagedToolV2Checkpoint, ['sessionId', 'promptId']],
  [METHODS.sessionManagedToolV2History, ['sessionId']],
  [METHODS.sessionManagedToolV2Manifest, ['sessionId']],
  [METHODS.sessionManagedToolV2BeginTurn, ['sessionId', 'identity']],
  [
    METHODS.sessionManagedToolV2Prepare,
    [
      'sessionId',
      'identity',
      'toolName',
      'input',
      'modification',
      'mediaContext',
    ],
  ],
  [METHODS.sessionManagedToolV2Confirmation, ['sessionId', 'reference']],
  [
    METHODS.sessionManagedToolV2Confirm,
    ['sessionId', 'reference', 'outcome', 'payload', 'phase'],
  ],
  [METHODS.sessionManagedToolV2Preflight, ['sessionId', 'reference']],
  [METHODS.sessionManagedToolV2Execute, ['sessionId', 'reference']],
  [METHODS.sessionManagedToolV2Status, ['sessionId', 'reference', 'afterSeq']],
  [METHODS.sessionManagedToolV2Cancel, ['sessionId', 'reference']],
]);

export function isManagedToolRuntimeMethod(method: string): boolean {
  return methodKeys.has(method);
}

export function isManagedToolRuntimeDrainMethod(method: string): boolean {
  return (
    method === METHODS.sessionManagedToolV2Status ||
    method === METHODS.sessionManagedToolV2Cancel ||
    method === METHODS.sessionManagedToolV2History
  );
}

export function parseManagedToolRuntimeSessionId(
  method: string,
  params: Record<string, unknown>,
): string {
  managedToolDigest(
    params,
    method === METHODS.sessionManagedToolV2BindHistory
      ? MANAGED_TOOL_FILE_HISTORY_MAX_BYTES
      : 1024 * 1024,
  );
  const keys = methodKeys.get(method);
  if (!keys || Object.keys(params).some((key) => !keys.includes(key))) {
    throw new ManagedToolProtocolError();
  }
  const session = parseCallerSuppliedSessionId(params['sessionId']);
  if (session.kind !== 'valid' || session.sessionId !== params['sessionId'])
    throw new ManagedToolProtocolError();
  return session.sessionId;
}

export const createManagedToolRuntimeSession = createBuiltinManagedToolRuntime;

export async function dispatchManagedToolRuntimeRequest(
  runtime: ManagedToolRuntime | ManagedToolV2Client,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = parseManagedToolRuntimeSessionId(method, params);
  if (
    method === METHODS.sessionManagedToolV2BindHistory ||
    method === METHODS.sessionManagedToolV2Checkpoint ||
    method === METHODS.sessionManagedToolV2History
  ) {
    if (!('fileHistory' in runtime) || !runtime.fileHistory)
      throw new ManagedToolProtocolError(
        'Managed file history is unavailable.',
      );
    const history = runtime.fileHistory;
    const state =
      method === METHODS.sessionManagedToolV2BindHistory
        ? await history.bind(
            parseManagedToolFileHistoryBinding(params['binding']),
          )
        : method === METHODS.sessionManagedToolV2Checkpoint
          ? await history.checkpoint(
              parseManagedToolFileHistoryPromptId(params['promptId']),
            )
          : await history.snapshot();
    return { ...parseManagedToolFileHistoryState(state) };
  }
  if (method === METHODS.sessionManagedToolV2Manifest)
    return { ...(await runtime.manifest()) };
  if (
    method === METHODS.sessionManagedToolV2BeginTurn ||
    method === METHODS.sessionManagedToolV2Prepare
  ) {
    const identity = parseManagedToolCallIdentity(params['identity']);
    if (identity.sessionId !== sessionId) throw new ManagedToolProtocolError();
    if (method === METHODS.sessionManagedToolV2BeginTurn) {
      await runtime.beginTurn(identity);
      return { started: true };
    }
    const name = params['toolName'];
    const input = params['input'];
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > 256 ||
      name.includes('\0') ||
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      throw new ManagedToolProtocolError();
    managedToolDigest(input);
    const args = input as Record<string, unknown>;
    if (
      name === ToolNames.SHELL &&
      args['is_background'] !== undefined &&
      args['is_background'] !== false
    ) {
      throw new ManagedToolProtocolError(
        'Managed Tool Runtime currently requires foreground Shell execution.',
      );
    }
    const modification =
      params['modification'] === undefined
        ? undefined
        : parseManagedToolContentModification(params['modification']);
    const mediaContext =
      params['mediaContext'] === undefined
        ? undefined
        : parseManagedToolMediaContext(params['mediaContext']);
    return {
      ...(await (mediaContext !== undefined
        ? runtime.prepare(identity, name, args, modification, mediaContext)
        : modification === undefined
          ? runtime.prepare(identity, name, args)
          : runtime.prepare(identity, name, args, modification))),
    };
  }
  const reference = parseManagedToolInvocationReference(params['reference']);
  if (reference.sessionId !== sessionId) throw new ManagedToolProtocolError();
  switch (method) {
    case METHODS.sessionManagedToolV2Confirmation:
      return { ...(await runtime.confirmation(reference)) };
    case METHODS.sessionManagedToolV2Confirm: {
      const outcome = params['outcome'];
      if (
        !Object.values(ToolConfirmationOutcome).some(
          (value) => value === outcome,
        )
      )
        throw new ManagedToolProtocolError();
      const phase =
        params['phase'] === undefined ? 'permission' : params['phase'];
      if (phase !== 'permission' && phase !== 'preflight')
        throw new ManagedToolProtocolError();
      await runtime.confirm(
        reference,
        outcome as ToolConfirmationOutcome,
        parseManagedToolConfirmationPayload(params['payload']),
        phase,
      );
      return { confirmed: true };
    }
    case METHODS.sessionManagedToolV2Preflight:
      return { ...(await runtime.preflight(reference)) };
    case METHODS.sessionManagedToolV2Execute: {
      const result = { ...(await runtime.execute(reference)) };
      managedToolResponseMediaBytes(result, 'execute');
      return result;
    }
    case METHODS.sessionManagedToolV2Status: {
      const afterSeq =
        params['afterSeq'] === undefined ? 0 : params['afterSeq'];
      if (
        typeof afterSeq !== 'number' ||
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0
      )
        throw new ManagedToolProtocolError();
      const result = { ...(await runtime.status(reference, afterSeq)) };
      managedToolResponseMediaBytes(result, 'status');
      return result;
    }
    case METHODS.sessionManagedToolV2Cancel: {
      const result = { ...(await runtime.cancel(reference)) };
      managedToolResponseMediaBytes(result, 'cancel');
      return result;
    }
    default:
      throw new ManagedToolProtocolError();
  }
}
