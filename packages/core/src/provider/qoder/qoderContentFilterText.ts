/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UiLocale } from '../../utils/locale.js';

/** Recovery guidance for the service's 406 response; not a model refusal. */
export function getContentFilterMessage(locale: UiLocale = 'en'): string {
  return locale === 'zh-CN'
    ? '模型服务拒绝了当前会话内容。请使用 /clear 新建会话后重新描述任务。'
    : 'The model service rejected the conversation content. Use /clear to start a new conversation and restate your task.';
}
