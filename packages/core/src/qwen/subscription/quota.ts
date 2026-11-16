/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface QwenSubscriptionQuotaDisplay {
  type: 'subscription_quota';
  memberType?: string;
  resetAt?: number;
  requestId?: string;
}

const VALID_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_QUOTA_ERROR_BODY_BYTES = 64 * 1024;

export function normalizeQwenSubscriptionRequestId(
  value: unknown,
): string | undefined {
  return typeof value === 'string' && VALID_REQUEST_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export function readQwenSubscriptionQuotaDisplay(
  value: unknown,
): QwenSubscriptionQuotaDisplay | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data['type'] !== 'subscription_quota') return undefined;
  const requestId = normalizeQwenSubscriptionRequestId(data['requestId']);
  return {
    type: 'subscription_quota',
    ...(typeof data['memberType'] === 'string'
      ? { memberType: data['memberType'] }
      : {}),
    ...(typeof data['resetAt'] === 'number' &&
    Number.isInteger(data['resetAt']) &&
    data['resetAt'] > 0 &&
    data['resetAt'] < 1e11 &&
    Number.isFinite(new Date(data['resetAt'] * 1000).getTime())
      ? { resetAt: data['resetAt'] }
      : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

export function qwenSubscriptionQuotaDisplay(
  status: number | undefined,
  detail: Record<string, unknown>,
  requestId?: string,
): QwenSubscriptionQuotaDisplay | undefined {
  if (status !== 402 || detail['code'] !== 'insufficient_quota') {
    return undefined;
  }
  const quota =
    detail['quota'] && typeof detail['quota'] === 'object'
      ? (detail['quota'] as Record<string, unknown>)
      : {};
  const resolvedRequestId =
    normalizeQwenSubscriptionRequestId(detail['request_id']) ??
    normalizeQwenSubscriptionRequestId(requestId);
  return readQwenSubscriptionQuotaDisplay({
    type: 'subscription_quota',
    memberType: quota['member_type'],
    resetAt: quota['reset_at'],
    ...(resolvedRequestId !== undefined
      ? { requestId: resolvedRequestId }
      : {}),
  });
}

export function parseQwenSubscriptionQuotaFromBody(
  status: number | undefined,
  responseBody: string | undefined,
  requestId?: string,
): QwenSubscriptionQuotaDisplay | undefined {
  if (
    status !== 402 ||
    !responseBody ||
    responseBody.length > MAX_QUOTA_ERROR_BODY_BYTES
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;
  const detail =
    root['error'] && typeof root['error'] === 'object'
      ? (root['error'] as Record<string, unknown>)
      : root;
  return qwenSubscriptionQuotaDisplay(
    status,
    detail,
    requestId ??
      (typeof root['request_id'] === 'string' ? root['request_id'] : undefined),
  );
}

export type QwenSubscriptionQuotaTranslator = (
  key: string,
  params?: Record<string, string>,
) => string;

export function formatQwenSubscriptionQuotaDisplay(
  value: unknown,
  t: QwenSubscriptionQuotaTranslator = (key, params) =>
    key.replace(
      /\{\{(\w+)\}\}/g,
      (match, name: string) => params?.[name] ?? match,
    ),
): string | undefined {
  const quota = readQwenSubscriptionQuotaDisplay(value);
  if (!quota) return undefined;
  const { memberType, resetAt } = quota;
  const member = memberType?.trim().toLowerCase();
  const weekly = member === 'lite' || member === 'plus' || member === 'pro';
  const upgrade = member === 'lite' || member === 'plus';
  let reset = '';
  const remaining = resetAt === undefined ? 0 : resetAt * 1000 - Date.now();
  if (remaining > 0) {
    const totalHours = Math.ceil(remaining / 3_600_000);
    const days = remaining >= 86_400_000 ? Math.floor(totalHours / 24) : 0;
    const hours = days ? totalHours % 24 : totalHours;
    const formatHours = () =>
      hours === 1
        ? t('1 hour')
        : t('{{count}} hours', { count: String(hours) });
    if (days) {
      const daysText =
        days === 1
          ? t('1 day')
          : t('{{count}} days', { count: String(days) });
      const time =
        hours > 0
          ? t('{{days}} and {{hours}}', {
              days: daysText,
              hours: formatHours(),
            })
          : daysText;
      reset = t(' Your credits are expected to reset in {{time}}.', { time });
    } else {
      reset = t(' Your credits are expected to reset in {{time}}.', {
        time: formatHours(),
      });
    }
  }
  const message = upgrade
    ? t(
        "You've used up your weekly credits.{{reset}} You can wait or run /upgrade to get more credits.",
        { reset },
      )
    : weekly
      ? t(
          "You've used up your weekly credits.{{reset}} Please try again after the reset.",
          { reset },
        )
      : t(
          "You've used up your credits.{{reset}} Please try again after the reset.",
          { reset },
        );
  return message + (quota.requestId ? ` (request_id: ${quota.requestId})` : '');
}
