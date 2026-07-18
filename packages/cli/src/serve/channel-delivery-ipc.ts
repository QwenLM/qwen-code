import { randomUUID } from 'node:crypto';
import type { ChannelProactiveTarget } from '@qwen-code/channel-base';

export type ChannelDeliveryErrorCode =
  | 'channel_worker_unavailable'
  | 'channel_delivery_timeout'
  | 'channel_delivery_invalid'
  | 'channel_delivery_queue_full'
  | 'channel_delivery_failed';

const CHANNEL_DELIVERY_ERROR_CODES: ReadonlySet<string> = new Set([
  'channel_worker_unavailable',
  'channel_delivery_timeout',
  'channel_delivery_invalid',
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
  target: ChannelProactiveTarget;
  text: string;
}

export interface ChannelDeliveryRequestMessage {
  type: 'channel_delivery';
  id: string;
  expiresAt: number;
  request: ChannelDeliveryRequest;
}

export type ChannelDeliveryResultMessage =
  | {
      type: 'channel_delivery_result';
      id: string;
      ok: true;
    }
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

function isChannelProactiveTarget(
  value: unknown,
): value is ChannelProactiveTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    isNonEmptyString(target['channelName']) &&
    isNonEmptyString(target['chatId']) &&
    (target['threadId'] === undefined ||
      isNonEmptyString(target['threadId'])) &&
    (target['isGroup'] === undefined || typeof target['isGroup'] === 'boolean')
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
    isChannelProactiveTarget(request['target']) &&
    request['target'].channelName === request['channelName'] &&
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
