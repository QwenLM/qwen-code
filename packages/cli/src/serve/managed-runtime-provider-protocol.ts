/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  managedToolDigest,
  parseManagedToolCallIdentity,
  parseManagedToolConfirmationPayload,
  parseManagedToolContentModification,
  parseManagedToolInvocationReference,
  parseManagedToolMediaContext,
  type ManagedToolCallIdentity,
  type ManagedToolContentModification,
  type ManagedToolInvocationReference,
  type ManagedToolMediaContext,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  parseManagedToolFileHistoryBinding,
  parseManagedToolFileHistoryPromptId,
  parseManagedToolFileHistoryState,
  type ManagedToolFileHistoryBinding,
} from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ToolConfirmationPayload } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ManagedToolConfirmationPhase } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';

export const MANAGED_RUNTIME_PROVIDER_PROTOCOL = 'managed-runtime-provider/1';
export const MANAGED_RUNTIME_PROVIDER_ROUTE = Object.freeze({
  key: 'provider-control',
  method: 'POST',
  path: '/internal/managed-runtime/provider/v1/control',
  protocolVersion: 1,
  requestBodyLimitBytes: 8 * 1024 * 1024,
  responseBodyLimitBytes: 8 * 1024 * 1024,
  cacheControl: 'no-store',
} as const);

export interface ManagedRuntimeProviderSession {
  readonly harnessSessionId: string;
  readonly runtimeSessionId: string;
  readonly turnKind: 'bootstrap' | 'continuation';
}

export type ManagedRuntimeProviderControl =
  | { kind: 'manifest' | 'history' }
  | { kind: 'begin-turn'; identity: ManagedToolCallIdentity }
  | {
      kind: 'prepare';
      identity: ManagedToolCallIdentity;
      toolName: string;
      input: Record<string, unknown>;
      modification?: ManagedToolContentModification;
      mediaContext?: ManagedToolMediaContext;
    }
  | {
      kind: 'confirmation' | 'preflight';
      reference: ManagedToolInvocationReference;
    }
  | {
      kind: 'confirm';
      reference: ManagedToolInvocationReference;
      outcome: ToolConfirmationOutcome;
      payload?: ToolConfirmationPayload;
      phase?: ManagedToolConfirmationPhase;
    }
  | { kind: 'bind-history'; binding: ManagedToolFileHistoryBinding }
  | { kind: 'checkpoint'; promptId: string };

export type ManagedRuntimeProviderOperation =
  | ManagedRuntimeProviderControl
  | { kind: 'acquire' | 'release' }
  | { kind: 'execute' | 'cancel'; reference: ManagedToolInvocationReference }
  | {
      kind: 'status';
      reference: ManagedToolInvocationReference;
      afterSequence?: number;
    };

export interface ManagedRuntimeProviderRequest {
  protocolVersion: 1;
  providerProtocol: typeof MANAGED_RUNTIME_PROVIDER_PROTOCOL;
  session: ManagedRuntimeProviderSession;
  operation: ManagedRuntimeProviderOperation;
}

export class ManagedRuntimeProviderProtocolError extends Error {
  constructor(
    message = 'Managed Runtime provider request is invalid.',
    readonly status = 400,
    readonly code = 'managed_runtime_provider_invalid',
  ) {
    super(message);
    this.name = 'ManagedRuntimeProviderProtocolError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedRuntimeProviderProtocolError();
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new ManagedRuntimeProviderProtocolError();
}

function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 512 ||
    value.includes('\0')
  )
    throw new ManagedRuntimeProviderProtocolError();
  return value;
}

function sequence(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ManagedRuntimeProviderProtocolError();
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function checkSession(
  identity: ManagedToolCallIdentity,
  session: ManagedRuntimeProviderSession,
): void {
  if (identity.sessionId !== session.runtimeSessionId)
    throw new ManagedRuntimeProviderProtocolError(
      'Managed Runtime provider Session identity conflicts.',
      409,
      'managed_runtime_identity_conflict',
    );
}

export function managedRuntimeProviderLimit(kind: string): number {
  return ['bind-history', 'checkpoint', 'history'].includes(kind)
    ? 8 * 1024 * 1024
    : 1024 * 1024;
}

export function parseManagedRuntimeProviderOperation(
  value: unknown,
  session: ManagedRuntimeProviderSession,
): ManagedRuntimeProviderOperation {
  const op = object(value);
  const kind = id(op['kind']);
  managedToolDigest(value, managedRuntimeProviderLimit(kind));
  switch (kind) {
    case 'acquire':
    case 'release':
    case 'manifest':
    case 'history':
      keys(op, ['kind']);
      break;
    case 'begin-turn':
    case 'prepare': {
      keys(
        op,
        kind === 'prepare'
          ? ['kind', 'identity', 'toolName', 'input']
          : ['kind', 'identity'],
        kind === 'prepare' ? ['modification', 'mediaContext'] : [],
      );
      checkSession(parseManagedToolCallIdentity(op['identity']), session);
      if (kind === 'prepare') {
        id(op['toolName']);
        object(op['input']);
        if ('modification' in op)
          checkSession(
            parseManagedToolContentModification(op['modification']).source,
            session,
          );
        if ('mediaContext' in op)
          parseManagedToolMediaContext(op['mediaContext']);
      }
      break;
    }
    case 'confirmation':
    case 'confirm':
    case 'preflight':
    case 'execute':
    case 'status':
    case 'cancel':
      keys(
        op,
        kind === 'confirm'
          ? ['kind', 'reference', 'outcome']
          : ['kind', 'reference'],
        kind === 'confirm'
          ? ['payload', 'phase']
          : kind === 'status'
            ? ['afterSequence']
            : [],
      );
      checkSession(
        parseManagedToolInvocationReference(op['reference']),
        session,
      );
      if (kind === 'confirm') {
        if (
          !Object.values(ToolConfirmationOutcome).includes(
            op['outcome'] as ToolConfirmationOutcome,
          ) ||
          op['outcome'] === ToolConfirmationOutcome.RestorePrevious
        )
          throw new ManagedRuntimeProviderProtocolError();
        if ('payload' in op) parseManagedToolConfirmationPayload(op['payload']);
        if ('phase' in op && !oneOf(op['phase'], ['permission', 'preflight']))
          throw new ManagedRuntimeProviderProtocolError();
      }
      if ('afterSequence' in op) sequence(op['afterSequence']);
      break;
    case 'bind-history': {
      keys(op, ['kind', 'binding']);
      const binding = parseManagedToolFileHistoryBinding(op['binding']);
      if (
        binding.ownerSessionId !== session.harnessSessionId ||
        binding.ownerRuntimeSessionId !== session.runtimeSessionId
      )
        throw new ManagedRuntimeProviderProtocolError(
          'Managed Runtime file history owner conflicts.',
          409,
          'managed_runtime_identity_conflict',
        );
      break;
    }
    case 'checkpoint':
      keys(op, ['kind', 'promptId']);
      parseManagedToolFileHistoryPromptId(op['promptId']);
      break;
    default:
      throw new ManagedRuntimeProviderProtocolError(
        'Managed Runtime provider operation is unsupported.',
        501,
        'managed_runtime_provider_unsupported',
      );
  }
  return structuredClone(value) as ManagedRuntimeProviderOperation;
}

export function parseManagedRuntimeProviderRequest(
  value: unknown,
): ManagedRuntimeProviderRequest {
  const request = object(value);
  keys(request, [
    'protocolVersion',
    'providerProtocol',
    'session',
    'operation',
  ]);
  if (
    request['protocolVersion'] !== 1 ||
    request['providerProtocol'] !== MANAGED_RUNTIME_PROVIDER_PROTOCOL
  )
    throw new ManagedRuntimeProviderProtocolError(
      'Managed Runtime provider protocol is incompatible.',
      409,
      'managed_runtime_provider_incompatible',
    );
  const session = object(request['session']);
  keys(session, ['harnessSessionId', 'runtimeSessionId', 'turnKind']);
  id(session['harnessSessionId']);
  id(session['runtimeSessionId']);
  if (!oneOf(session['turnKind'], ['bootstrap', 'continuation']))
    throw new ManagedRuntimeProviderProtocolError();
  const parsedSession = session as unknown as ManagedRuntimeProviderSession;
  const parsed: ManagedRuntimeProviderRequest = {
    protocolVersion: 1,
    providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
    session: structuredClone(parsedSession),
    operation: parseManagedRuntimeProviderOperation(
      request['operation'],
      parsedSession,
    ),
  };
  managedToolDigest(value, managedRuntimeProviderLimit(parsed.operation.kind));
  return parsed;
}

export function parseManagedRuntimeProviderResult(
  operation: ManagedRuntimeProviderOperation,
  value: unknown,
  session: ManagedRuntimeProviderSession,
): unknown {
  managedToolDigest(value, managedRuntimeProviderLimit(operation.kind));
  if (operation.kind === 'begin-turn' || operation.kind === 'confirm') {
    if (value !== null) throw new ManagedRuntimeProviderProtocolError();
    return null;
  }
  if (operation.kind === 'acquire' || operation.kind === 'release') {
    if (value !== true) throw new ManagedRuntimeProviderProtocolError();
    return true;
  }
  const result = object(value);
  switch (operation.kind) {
    case 'bind-history':
    case 'checkpoint':
    case 'history': {
      const state = parseManagedToolFileHistoryState(value);
      if (state.ownerSessionId !== session.harnessSessionId)
        throw new ManagedRuntimeProviderProtocolError(
          'Managed file history owner changed.',
        );
      return state;
    }
    case 'manifest':
      keys(result, ['tools', 'capabilityDigest', 'policyRevision']);
      id(result['policyRevision']);
      if (
        !Array.isArray(result['tools']) ||
        managedToolDigest(result['tools'], 1024 * 1024) !==
          result['capabilityDigest']
      )
        throw new ManagedRuntimeProviderProtocolError(
          'Managed tool manifest digest changed.',
        );
      for (const tool of result['tools']) {
        const descriptor = object(tool);
        id(descriptor['name']);
        object(descriptor['schema']);
      }
      break;
    case 'prepare': {
      const reference = Object.fromEntries(
        [
          'sessionId',
          'promptId',
          'callId',
          'capabilityDigest',
          'policyRevision',
          'invocationId',
          'argsDigest',
        ].map((key) => [key, result[key]]),
      );
      checkSession(parseManagedToolInvocationReference(reference), session);
      for (const [key, expected] of Object.entries(operation.identity))
        if (result[key] !== expected)
          throw new ManagedRuntimeProviderProtocolError();
      object(result['params']);
      if (
        managedToolDigest(result['params']) !== result['argsDigest'] ||
        typeof result['description'] !== 'string' ||
        !Array.isArray(result['locations']) ||
        !oneOf(result['defaultPermission'], [
          'allow',
          'ask',
          'deny',
          'default',
        ]) ||
        typeof result['requiresUserInteraction'] !== 'boolean'
      )
        throw new ManagedRuntimeProviderProtocolError();
      id(result['toolUseId']);
      break;
    }
    case 'confirmation':
      if (
        !oneOf(result['type'], ['edit', 'exec', 'mcp', 'info']) ||
        typeof result['title'] !== 'string'
      )
        throw new ManagedRuntimeProviderProtocolError();
      break;
    case 'preflight':
      if (typeof result['shouldProceed'] !== 'boolean')
        throw new ManagedRuntimeProviderProtocolError();
      break;
    case 'execute':
      if (
        !oneOf(result['executionStatus'], [
          'not_started',
          'success',
          'error',
          'cancelled',
        ])
      )
        throw new ManagedRuntimeProviderProtocolError();
      if (result['executionStatus'] === 'success') object(result['result']);
      break;
    case 'status':
    case 'cancel':
      if (result['state'] === 'unknown') {
        keys(result, ['state']);
        break;
      }
      if (
        !oneOf(result['state'], [
          'prepared',
          'executing',
          'cancel_requested',
          'settled',
        ]) ||
        typeof result['cancelRequested'] !== 'boolean' ||
        typeof result['progressGap'] !== 'boolean' ||
        !Array.isArray(result['progress'])
      )
        throw new ManagedRuntimeProviderProtocolError();
      sequence(result['lastSeq']);
      sequence(result['firstAvailableSeq']);
      if (result['state'] === 'settled')
        parseManagedRuntimeProviderResult(
          { kind: 'execute', reference: operation.reference },
          result['result'],
          session,
        );
      else if ('result' in result)
        throw new ManagedRuntimeProviderProtocolError();
      break;
    default:
      throw new ManagedRuntimeProviderProtocolError();
  }
  return structuredClone(value);
}
