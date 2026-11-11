/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * control_response 错误体归一，与 wire 请求体的字段判别。
 *
 * 会话链与 sdk 接入层共用这一份（sdk 可以 import thread-manager，反过来不行）。
 * 同一失败在不同入口给出的 `code` 必须一致，SDK 侧按 `code` 分支。
 * 本文件的契约由 `protocolError.test.ts` 的黄金用例钉住。
 */

/**
 * 把异常归一成 control_response 错误体 `{error, code?}`。`code` 有两个来源：异常对象
 * 自己的 `code` 属性，以及消息文本里的 `some_code: 正文` 前缀；命中前缀时正文会被剥掉
 * 前缀，SDK 侧按 `code` 分支、按 `error` 展示。
 */
export function normalizeProtocolError(error: unknown): {
  error: string;
  code?: string;
} {
  let message = error instanceof Error ? error.message : String(error);
  const rawCode =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const codeFromProperty =
    typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined;
  const prefixedCodeMatch = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(message);

  if (prefixedCodeMatch) {
    const code = codeFromProperty ?? prefixedCodeMatch[1];
    if (!codeFromProperty || codeFromProperty === prefixedCodeMatch[1]) {
      message = prefixedCodeMatch[2] || message;
    }
    return { error: message, code };
  }

  return codeFromProperty
    ? { error: message, code: codeFromProperty }
    : { error: message };
}

/** wire 请求体的字符串字段判别：`key in obj` 保证「显式传了空串」不被当成缺失。 */
export function isStringProp<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<string, unknown> & Record<K, string> {
  const val = obj[key];
  return key in obj && typeof val === 'string';
}
