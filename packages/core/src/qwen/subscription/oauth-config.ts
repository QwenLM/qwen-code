/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import { Storage } from '../../config/storage.js';

/** Provider id used by the `settings.providers` entry written at sign-in. */
export const QWEN_SUBSCRIPTION_PROVIDER_ID = 'qwen-subscription';
/** Fixed inference gateway for Qwen membership accounts. */
export const QWEN_SUBSCRIPTION_BASE_URL =
  'https://api.qwen.ai/compatible-mode/v1';
/** Model activated by an explicit sign-in when the catalog lists it. */
export const QWEN_SUBSCRIPTION_MODEL = 'qwen3.8-max';
/**
 * Placeholder credential stored in settings. The real bearer token is read
 * from the subscription credential file at request time.
 */
export const QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER =
  'QWEN_SUBSCRIPTION_DYNAMIC_TOKEN';

export interface QwenOAuthConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly webOrigin: string;
}

export function getQwenOAuthConfig(): QwenOAuthConfig {
  return {
    baseUrl: 'https://auth.qwen.ai',
    clientId: 'qwen-code-cli',
    webOrigin: 'https://chat.qwen.ai',
  };
}

export type QwenPaywallScene = 'cli' | 'desktop' | 'plugin';

function formatQwenChatUrl(url: URL, scene: QwenPaywallScene): string {
  url.searchParams.set('entry', 'qwen_code');
  url.searchParams.set('paywallScene', scene);
  return url.toString();
}

/** Membership plans page shared by `/upgrade` and the purchase guidance. */
export function getQwenSubscriptionPlansUrl(
  scene: QwenPaywallScene = 'cli',
): string {
  const url = new URL('/', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('memberPlan', 'qwen_code');
  return formatQwenChatUrl(url, scene);
}

/** Browser authorization page for a device code. */
export function getQwenSubscriptionAuthorizationUrl(
  device: {
    readonly user_code: string;
  },
  scene: QwenPaywallScene = 'cli',
): string {
  const url = new URL('/authorize', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('user_code', device.user_code);
  url.searchParams.set('client', scene);
  return formatQwenChatUrl(url, scene);
}

export function getQwenSubscriptionCredentialsPath(): string {
  return path.join(
    Storage.getGlobalConfigDir(),
    'subscription_credentials.json',
  );
}
