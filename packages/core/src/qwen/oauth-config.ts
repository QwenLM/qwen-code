/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const QWEN_SUBSCRIPTION_BASE_URL =
  'https://api.qwen.ai/compatible-mode/v1';
export const QWEN_SUBSCRIPTION_MODEL = 'qwen3.8-max';
export const QWEN_SUBSCRIPTION_WEB_SEARCH_URL =
  'https://api.qwen.ai/api/v1/mcp/web_search';
export const QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER =
  'QWEN_SUBSCRIPTION_DYNAMIC_TOKEN';

export function getQwenOAuthConfig(): {
  baseUrl: string;
  clientId: string;
  webOrigin: string;
} {
  return {
    baseUrl: 'https://auth.qwen.ai',
    clientId: 'qwen-code-cli',
    webOrigin: 'https://chat.qwen.ai',
  };
}

export type QwenChatClient = 'cli' | 'desktop' | 'plugin';

export function withQwenChatClient(
  rawUrl: string,
  client: QwenChatClient,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.origin !== getQwenOAuthConfig().webOrigin) return rawUrl;
  url.searchParams.set('client', client);
  return url.toString();
}

export function getQwenSubscriptionAuthorizationUrl(
  userCode: string,
  client: QwenChatClient,
): string {
  const url = new URL('/authorize', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('user_code', userCode);
  url.searchParams.set('client', client);
  return url.toString();
}

export function getQwenSubscriptionPlansUrl(client: QwenChatClient): string {
  const url = new URL('/', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('memberPlan', 'qwen_code');
  url.searchParams.set('client', client);
  return url.toString();
}
