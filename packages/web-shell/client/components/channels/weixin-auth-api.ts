/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonClient,
  DaemonWeixinAccountStatus,
  DaemonWeixinLoginFlow,
} from '@qwen-code/sdk/daemon';
import { createDaemonRestRequest } from '../../daemon/rest-request.js';

/**
 * The WeChat credential is process-global, so these routes have no workspace
 * segment and are called on the root client — the same shape as
 * `local-control-api.ts`, not the workspace-scoped channel management client.
 */
export interface WeixinAuthTarget {
  baseUrl: string;
  token?: string;
  client?: DaemonClient;
}

export class WeixinAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WeixinAuthError';
  }
}

async function send<T>(
  target: WeixinAuthTarget,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
): Promise<T | undefined> {
  const response = await createDaemonRestRequest(
    target.baseUrl,
    target.token,
    target.client,
  )(path, {
    method,
    headers: new Headers(
      target.token ? { Authorization: `Bearer ${target.token}` } : undefined,
    ),
    signal: AbortSignal.timeout(15_000),
  });
  // A daemon that predates these routes answers 404; callers render that as
  // "unsupported" rather than as a failure.
  if (response.status === 404) return undefined;
  const text = await response.text();
  let payload: (T & { code?: string; error?: string }) | undefined;
  try {
    payload = (text ? JSON.parse(text) : undefined) as
      | (T & { code?: string; error?: string })
      | undefined;
  } catch {
    if (response.ok) throw new WeixinAuthError('Invalid WeChat login response');
  }
  if (!response.ok) {
    throw new WeixinAuthError(
      payload?.error?.trim() ||
        payload?.code ||
        response.statusText ||
        `WeChat login request failed (${response.status})`,
      payload?.code,
      response.status,
    );
  }
  return payload;
}

export async function getWeixinAccountStatus(
  target: WeixinAuthTarget,
): Promise<DaemonWeixinAccountStatus | undefined> {
  return send<DaemonWeixinAccountStatus>(target, 'GET', '/auth/weixin');
}

export async function startWeixinLogin(
  target: WeixinAuthTarget,
): Promise<DaemonWeixinLoginFlow | undefined> {
  return send<DaemonWeixinLoginFlow>(target, 'POST', '/auth/weixin/flows');
}

export async function getWeixinLoginFlow(
  target: WeixinAuthTarget,
  id: string,
): Promise<DaemonWeixinLoginFlow | undefined> {
  return send<DaemonWeixinLoginFlow>(
    target,
    'GET',
    `/auth/weixin/flows/${encodeURIComponent(id)}`,
  );
}

/**
 * Drop one flow. The daemon's flow lives in its own map and keeps polling the
 * upstream whether or not a browser is watching, so a closing panel must say
 * so explicitly; otherwise four abandoned attempts exhaust the flow cap and
 * legitimate logins are refused until they time out.
 */
export async function cancelWeixinLoginFlow(
  target: WeixinAuthTarget,
  id: string,
): Promise<void> {
  await send<unknown>(
    target,
    'DELETE',
    `/auth/weixin/flows/${encodeURIComponent(id)}`,
  );
}

export async function revokeWeixinLogin(
  target: WeixinAuthTarget,
): Promise<void> {
  await send<unknown>(target, 'POST', '/auth/weixin/revoke');
}
