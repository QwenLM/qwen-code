/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 唯一注入缝：宿主令牌来源。
 *
 * 令牌要按需向上游索取，而索取是 wire 行为，所以本模块只声明「我需要一个令牌来源」，
 * 由宿主提供实现。「需要按需取令牌」是登录态语义，属于本模块；「怎么向上游发这个请求」
 * 是协议，属于宿主。因此字段一律是产品形状（camelCase），蛇形 wire 键的翻译留在宿主
 * 实现里。threadManager 不得反向 import 宿主的反向请求声明。
 */

/** 宿主发回的令牌（产品形状；wire 的蛇形 expires_at 由宿主实现翻译）。 */
export interface ThreadHostToken {
  readonly token: string;
  readonly expiresAt?: number;
}

/** 取令牌的原因。策略侧的 'expiring'（到期前主动重拉）由本模块归一成 'initial'。 */
export type ThreadHostTokenReason = 'initial' | 'unauthorized';

export interface ThreadHostTokenSource {
  fetchJobToken(
    params: { reason: ThreadHostTokenReason; sessionId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<ThreadHostToken>;
  fetchServiceAccountToken(
    params: {
      reason: ThreadHostTokenReason;
      requiredScopes: readonly string[];
    },
    options?: { signal?: AbortSignal },
  ): Promise<ThreadHostToken>;
}
