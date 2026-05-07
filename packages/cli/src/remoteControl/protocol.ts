/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CLIControlRequest,
  CLIControlResponse,
  CLIMessage,
  PermissionMode,
} from '../nonInteractive/types.js';

export const REMOTE_CONTROL_PROTOCOL_VERSION = 1;
export const DEFAULT_REMOTE_CONTROL_PORT = 7373;
export const DEFAULT_PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CLIENTS = 5;
export const DEFAULT_EVENT_LOG_LIMIT = 1000;

export type RemoteSessionMode = 'worker' | 'tui';

export type RemoteSessionState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting_for_approval'
  | 'interrupted'
  | 'error'
  | 'closed';

export interface RemoteEnvelope<TPayload = unknown> {
  v: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  id?: string;
  type: string;
  sessionId?: string;
  seq?: number;
  ts?: string;
  payload?: TPayload;
}

export interface RemoteEvent<TPayload = unknown> {
  id: string;
  seq: number;
  sessionId: string;
  type: string;
  createdAt: string;
  payload: TPayload;
}

export interface RemoteSessionCreatePayload {
  name?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  mode?: RemoteSessionMode;
}

export interface RemoteUserSubmitPayload {
  text: string;
}

export interface RemoteToolResponsePayload {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: unknown;
}

export interface RemoteSetModelPayload {
  model: string;
}

export interface RemoteSetPermissionModePayload {
  mode: PermissionMode;
}

export interface RemoteHistoryPayload {
  since?: number;
}

export interface RemoteAuthPayload {
  token: string;
}

export interface RemoteSessionSnapshot {
  id: string;
  name?: string;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  mode: RemoteSessionMode;
  state: RemoteSessionState;
  pid?: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export type RemoteChildMessage =
  | CLIMessage
  | CLIControlRequest
  | CLIControlResponse
  | Record<string, unknown>;

export interface RemoteCapabilities {
  canCreateWorkerSession: boolean;
  canAttachCurrentTui: boolean;
  canStreamEvents: boolean;
  canReplayHistory: boolean;
  canApproveTools: boolean;
  canInterrupt: boolean;
  canSetModel: boolean;
  canSetPermissionMode: boolean;
}

export function buildCapabilities(
  overrides: Partial<RemoteCapabilities> = {},
): RemoteCapabilities {
  return {
    canCreateWorkerSession: true,
    canAttachCurrentTui: false,
    canStreamEvents: true,
    canReplayHistory: true,
    canApproveTools: true,
    canInterrupt: true,
    canSetModel: true,
    canSetPermissionMode: true,
    ...overrides,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireStringField(
  value: Record<string, unknown>,
  field: string,
): string {
  const raw = value[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`Missing or invalid field: ${field}`);
  }
  return raw;
}

export function optionalStringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = value[field];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error(`Invalid field: ${field}`);
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalNumberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const raw = value[field];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`Invalid field: ${field}`);
  }
  return raw;
}

export function parseRemoteEnvelope(raw: unknown): RemoteEnvelope {
  if (!isRecord(raw)) {
    throw new Error('Remote message must be an object');
  }
  if (raw['v'] !== REMOTE_CONTROL_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported remote-control protocol version: ${String(raw['v'])}`,
    );
  }
  const type = requireStringField(raw, 'type');
  const envelope: RemoteEnvelope = {
    v: REMOTE_CONTROL_PROTOCOL_VERSION,
    type,
  };
  const id = optionalStringField(raw, 'id');
  const sessionId = optionalStringField(raw, 'sessionId');
  const seq = optionalNumberField(raw, 'seq');
  if (id) {
    envelope.id = id;
  }
  if (sessionId) {
    envelope.sessionId = sessionId;
  }
  if (seq !== undefined) {
    envelope.seq = seq;
  }
  if ('payload' in raw) {
    envelope.payload = raw['payload'];
  }
  return envelope;
}

export function makeEnvelope<TPayload>(
  type: string,
  payload?: TPayload,
  options: {
    id?: string;
    sessionId?: string;
    seq?: number;
    ts?: string;
  } = {},
): RemoteEnvelope<TPayload> {
  return {
    v: REMOTE_CONTROL_PROTOCOL_VERSION,
    type,
    ...(options.id && { id: options.id }),
    ...(options.sessionId && { sessionId: options.sessionId }),
    ...(options.seq !== undefined && { seq: options.seq }),
    ts: options.ts ?? new Date().toISOString(),
    ...(payload !== undefined && { payload }),
  };
}

export function eventToEnvelope(event: RemoteEvent): RemoteEnvelope {
  return makeEnvelope(event.type, event.payload, {
    id: event.id,
    sessionId: event.sessionId,
    seq: event.seq,
    ts: event.createdAt,
  });
}
