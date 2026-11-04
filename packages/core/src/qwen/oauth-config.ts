/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const QWEN_SUBSCRIPTION_BASE_URL =
  'https://pre-api.qwen.ai/compatible-mode/v1';
export const QWEN_SUBSCRIPTION_MODEL = 'qwen3.8-max';
export const QWEN_SUBSCRIPTION_WEB_SEARCH_URL =
  'https://pre-api.qwen.ai/api/v1/mcp/web_search';
export const QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER =
  'QWEN_SUBSCRIPTION_DYNAMIC_TOKEN';

export function getQwenOAuthConfig(): {
  baseUrl: string;
  clientId: string;
  webOrigin: string;
} {
  return {
    baseUrl: 'https://pre-auth.qwen.ai',
    clientId: 'qwen-code-cli',
    webOrigin: 'https://pre4-chat.qwen.ai',
  };
}

export function getQwenSubscriptionPlansUrl(): string {
  const url = new URL('/', getQwenOAuthConfig().webOrigin);
  url.searchParams.set('memberPlan', 'qwen_code');
  return url.toString();
}
