/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeManagedRuntimeToolExecuteRequest,
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { parseCallerSuppliedSessionId } from '../config/session-id.js';

export const MANAGED_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const MANAGED_RUNTIME_ROUTE_PREFIX =
  '/internal/managed-runtime/v1' as const;

const MAX_ID_LENGTH = 256;
const MAX_EXECUTION_ID_LENGTH = 128;
const MAX_TURN_ID_LENGTH = 128;
const MAX_TOOL_CALL_ID_LENGTH = 512;
const MAX_WORKSPACE_CWD_LENGTH = 4096;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_TOOL_INPUT_BYTES = 256 * 1024;
const PREPARE_KEYS = new Set([
  'protocolVersion',
  'tenantId',
  'workspaceId',
  'workspaceCwd',
  'sessionId',
  'turnKind',
]);

export interface ManagedRuntimePrepareRequest {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly sessionId: string;
  readonly turnKind: 'bootstrap' | 'continuation';
}

export interface ManagedRuntimeExecuteRequest
  extends ManagedRuntimePrepareRequest {
  readonly toolRequest: BridgeManagedRuntimeToolExecuteRequest;
}

export interface ManagedRuntimeCancelRequest
  extends ManagedRuntimePrepareRequest {
  readonly executionId: string;
}

export interface ManagedRuntimeReadyResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly ready: true;
}

export interface ManagedRuntimeManifestResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly manifest: BridgeManagedRuntimeToolManifest;
}

export interface ManagedRuntimeExecuteResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly result: BridgeManagedRuntimeToolExecuteResult;
}

export interface ManagedRuntimeCancelResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly cancelled: boolean;
}

export interface ManagedRuntimeReleaseResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly released: boolean;
}

export class ManagedRuntimeProtocolError extends Error {
  readonly code = 'managed_runtime_invalid_request';

  constructor(message = 'Managed Runtime request is invalid.') {
    super(message);
    this.name = 'ManagedRuntimeProtocolError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRuntimeProtocolError();
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new ManagedRuntimeProtocolError();
  }
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ManagedRuntimeProtocolError();
  }
}

function prepareFields(value: unknown): ManagedRuntimePrepareRequest {
  const input = record(value);
  if (input['protocolVersion'] !== MANAGED_RUNTIME_PROTOCOL_VERSION) {
    throw new ManagedRuntimeProtocolError(
      'Managed Runtime protocol version is unsupported.',
    );
  }
  const turnKind = input['turnKind'];
  if (turnKind !== 'bootstrap' && turnKind !== 'continuation') {
    throw new ManagedRuntimeProtocolError();
  }
  const sessionId = parseCallerSuppliedSessionId(input['sessionId']);
  if (sessionId.kind !== 'valid') {
    throw new ManagedRuntimeProtocolError();
  }
  return {
    protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
    tenantId: boundedString(input['tenantId'], MAX_ID_LENGTH),
    workspaceId: boundedString(input['workspaceId'], MAX_ID_LENGTH),
    workspaceCwd: boundedString(
      input['workspaceCwd'],
      MAX_WORKSPACE_CWD_LENGTH,
    ),
    sessionId: sessionId.sessionId,
    turnKind,
  };
}

export function parseManagedRuntimePrepareRequest(
  value: unknown,
): ManagedRuntimePrepareRequest {
  const input = record(value);
  assertKeys(input, PREPARE_KEYS);
  return prepareFields(input);
}

export function parseManagedRuntimeExecuteRequest(
  value: unknown,
): ManagedRuntimeExecuteRequest {
  const input = record(value);
  assertKeys(input, new Set([...PREPARE_KEYS, 'toolRequest']));
  const toolRequest = record(input['toolRequest']);
  assertKeys(
    toolRequest,
    new Set([
      'executionId',
      'turnId',
      'toolCallId',
      'capabilityDigest',
      'toolName',
      'input',
    ]),
  );
  const rawInput = record(toolRequest['input']);
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(rawInput);
  } catch {
    throw new ManagedRuntimeProtocolError();
  }
  if (Buffer.byteLength(serializedInput, 'utf8') > MAX_TOOL_INPUT_BYTES) {
    throw new ManagedRuntimeProtocolError();
  }
  return {
    ...prepareFields(input),
    toolRequest: {
      executionId: boundedString(
        toolRequest['executionId'],
        MAX_EXECUTION_ID_LENGTH,
      ),
      turnId: boundedString(toolRequest['turnId'], MAX_TURN_ID_LENGTH),
      toolCallId: boundedString(
        toolRequest['toolCallId'],
        MAX_TOOL_CALL_ID_LENGTH,
      ),
      capabilityDigest: (() => {
        const digest = boundedString(toolRequest['capabilityDigest'], 64);
        if (!/^[a-f0-9]{64}$/.test(digest)) {
          throw new ManagedRuntimeProtocolError();
        }
        return digest;
      })(),
      toolName: boundedString(toolRequest['toolName'], MAX_TOOL_NAME_LENGTH),
      input: structuredClone(rawInput),
    },
  };
}

export function parseManagedRuntimeCancelRequest(
  value: unknown,
): ManagedRuntimeCancelRequest {
  const input = record(value);
  assertKeys(input, new Set([...PREPARE_KEYS, 'executionId']));
  return {
    ...prepareFields(input),
    executionId: boundedString(input['executionId'], MAX_EXECUTION_ID_LENGTH),
  };
}

export function sameManagedRuntimeIdentity(
  left: ManagedRuntimePrepareRequest,
  right: ManagedRuntimePrepareRequest,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceCwd === right.workspaceCwd &&
    left.sessionId === right.sessionId
  );
}
