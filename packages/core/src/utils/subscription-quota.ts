/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SubscriptionQuotaDisplay {
  type: 'subscription_quota';
  memberType?: string;
  resetAt?: number;
  requestId?: string;
}

export function readSubscriptionQuotaDisplay(
  value: unknown,
): SubscriptionQuotaDisplay | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data['type'] !== 'subscription_quota') return undefined;
  return {
    type: 'subscription_quota',
    ...(typeof data['memberType'] === 'string'
      ? { memberType: data['memberType'] }
      : {}),
    ...(typeof data['resetAt'] === 'number' &&
    Number.isInteger(data['resetAt']) &&
    Number.isFinite(new Date(data['resetAt'] * 1000).getTime())
      ? { resetAt: data['resetAt'] }
      : {}),
    ...(typeof data['requestId'] === 'string' &&
    /^[A-Za-z0-9._-]{1,128}$/.test(data['requestId'])
      ? { requestId: data['requestId'] }
      : {}),
  };
}

export function subscriptionQuotaDisplay(
  status: number | undefined,
  detail: Record<string, unknown>,
): SubscriptionQuotaDisplay | undefined {
  if (status !== 402 || detail['code'] !== 'insufficient_quota')
    return undefined;
  const quota =
    detail['quota'] && typeof detail['quota'] === 'object'
      ? (detail['quota'] as Record<string, unknown>)
      : {};
  return readSubscriptionQuotaDisplay({
    type: 'subscription_quota',
    memberType: quota['member_type'],
    resetAt: quota['reset_at'],
  });
}

export function subscriptionQuotaFromError(
  error: unknown,
): SubscriptionQuotaDisplay | undefined {
  return error && typeof error === 'object'
    ? readSubscriptionQuotaDisplay(
        (error as { subscriptionQuota?: unknown }).subscriptionQuota,
      )
    : undefined;
}

export type SubscriptionQuotaTranslator = (
  key: string,
  params?: Record<string, string>,
) => string;

export function formatSubscriptionQuotaDisplay(
  value: unknown,
  t: SubscriptionQuotaTranslator = (key, params) =>
    key.replace(
      /\{\{(\w+)\}\}/g,
      (match, name: string) => params?.[name] ?? match,
    ),
): string | undefined {
  const quota = readSubscriptionQuotaDisplay(value);
  if (!quota) return undefined;
  const { memberType: member, resetAt } = quota;
  const weekly = member === 'lite' || member === 'plus' || member === 'pro';
  const upgrade = member === 'lite' || member === 'plus';
  let reset = '';
  const remaining = resetAt === undefined ? 0 : resetAt * 1000 - Date.now();
  if (remaining > 0) {
    const totalHours = Math.ceil(remaining / 3_600_000);
    const days = remaining >= 86_400_000 ? Math.floor(totalHours / 24) : 0;
    const hours = days ? totalHours % 24 : totalHours;
    const hourText =
      hours === 1
        ? t('1 hour')
        : t('{{count}} hours', { count: String(hours) });
    const time = days
      ? t('{{days}} and {{hours}}', {
          days:
            days === 1
              ? t('1 day')
              : t('{{count}} days', { count: String(days) }),
          hours: hourText,
        })
      : hourText;
    reset = t(' Your credits are expected to reset in {{time}}.', { time });
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
