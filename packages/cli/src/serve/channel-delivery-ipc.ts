/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

// Keep in sync with acp-bridge bridgeOptions.ts / bridgeClient.ts and sdk-typescript events.ts.
export type ChannelDeliveryErrorCode =
  | 'channel_worker_unavailable'
  | 'channel_delivery_timeout'
  | 'channel_delivery_invalid'
  | 'channel_delivery_rejected'
  | 'channel_delivery_queue_full'
  | 'channel_delivery_failed';

const CHANNEL_DELIVERY_ERROR_CODES: ReadonlySet<string> = new Set([
  'channel_worker_unavailable',
  'channel_delivery_timeout',
  'channel_delivery_invalid',
  'channel_delivery_rejected',
  'channel_delivery_queue_full',
  'channel_delivery_failed',
]);

export class ChannelDeliveryError extends Error {
  constructor(
    readonly code: ChannelDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelDeliveryError';
  }
}

export function isChannelDeliveryErrorCode(
  value: unknown,
): value is ChannelDeliveryErrorCode {
  return typeof value === 'string' && CHANNEL_DELIVERY_ERROR_CODES.has(value);
}

export function isChannelDeliveryError(
  value: unknown,
): value is ChannelDeliveryError {
  return (
    value instanceof ChannelDeliveryError ||
    (typeof value === 'object' &&
      value !== null &&
      isChannelDeliveryErrorCode((value as { code?: unknown }).code) &&
      typeof (value as { message?: unknown }).message === 'string')
  );
}

export interface ChannelDeliveryRequest {
  deliveryId: string;
  channelName: string;
  target: { type: 'user'; id: string } | { type: 'chat'; id: string };
  text: string;
}

export interface ChannelDeliveryRequestMessage {
  type: 'channel_delivery';
  id: string;
  expiresAt: number;
  request: ChannelDeliveryRequest;
}

export type ChannelDeliveryResultMessage =
  | { type: 'channel_delivery_result'; id: string; ok: true }
  | {
      type: 'channel_delivery_result';
      id: string;
      ok: false;
      code: ChannelDeliveryErrorCode;
      error: string;
    };

export interface ChannelDeliveryAccepted {
  delivered: true;
}

export const CHANNEL_DELIVERY_IPC_TIMEOUT_MS = 30_000;

export function createChannelDeliveryMessage(
  request: ChannelDeliveryRequest,
): ChannelDeliveryRequestMessage {
  return {
    type: 'channel_delivery',
    id: randomUUID(),
    expiresAt: Date.now() + CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
    request,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isChannelDeliveryTarget(
  value: unknown,
): value is ChannelDeliveryRequest['target'] {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    (target['type'] === 'user' || target['type'] === 'chat') &&
    isNonEmptyString(target['id']) &&
    Object.keys(target).every((key) => key === 'type' || key === 'id')
  );
}

function isChannelDeliveryRequest(
  value: unknown,
): value is ChannelDeliveryRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    isNonEmptyString(request['deliveryId']) &&
    isNonEmptyString(request['channelName']) &&
    isChannelDeliveryTarget(request['target']) &&
    isNonEmptyString(request['text'])
  );
}

export function isChannelDeliveryMessage(
  value: unknown,
): value is ChannelDeliveryRequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message['type'] === 'channel_delivery' &&
    isNonEmptyString(message['id']) &&
    typeof message['expiresAt'] === 'number' &&
    Number.isFinite(message['expiresAt']) &&
    isChannelDeliveryRequest(message['request'])
  );
}

export function isChannelDeliveryResultMessage(
  value: unknown,
): value is ChannelDeliveryResultMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (
    message['type'] !== 'channel_delivery_result' ||
    !isNonEmptyString(message['id']) ||
    typeof message['ok'] !== 'boolean'
  ) {
    return false;
  }
  if (message['ok']) return true;
  return (
    isChannelDeliveryErrorCode(message['code']) &&
    typeof message['error'] === 'string'
  );
}
