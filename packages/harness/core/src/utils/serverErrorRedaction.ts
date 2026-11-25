/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactSecrets } from './diagnosticRedaction.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 在错误元数据、日志及对外说明的入口统一脱敏，保留无凭据原文。 */
export function redactServerErrorText(message: string, depth = 0): string {
  if (depth > 16) return '[redacted]';
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === 'string') {
      const clean = redactServerErrorText(parsed, depth + 1);
      return clean === parsed ? message : JSON.stringify(clean);
    }
    if (parsed !== null && typeof parsed === 'object') {
      const clean = redactJsonValue(parsed, depth + 1);
      return JSON.stringify(clean) === JSON.stringify(parsed)
        ? message
        : JSON.stringify(clean);
    }
  } catch {
    // 普通文本继续使用既有凭据脱敏规则。
  }
  return redactSecrets(redactQueueFields(message))
    .replace(
      /(["'](?:authorization|cookie|set-cookie|password|passwd|secrets?|credentials?|tokens?|api[_-]?key|access[_-]?token|refresh[_-]?token)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      '$1"[redacted]"',
    )
    .replace(/\b((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]');
}

function redactJsonValue(value: unknown, depth: number): unknown {
  if (depth > 16) return '[redacted]';
  if (typeof value === 'string') return redactServerErrorText(value, depth);
  if (Array.isArray(value))
    return value.map((item) => redactJsonValue(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|set-cookie|password|passwd|secrets?|credentials?|tokens?|api[_-]?key|access[_-]?token|refresh[_-]?token|passkey|pass_key|line_up_id|line_up_type)$/i.test(
          key,
        )
          ? '[redacted]'
          : redactJsonValue(item, depth + 1),
      ]),
    );
  }
  return value;
}

function redactQueueFields(text: string): string {
  return text
    .replace(
      /(\\["'])(passkey|pass_key|line_up_id|line_up_type)(\\["'])\s*:\s*(\\["'])(.*?)(\\["'])/gi,
      (
        _match,
        open: string,
        key: string,
        close: string,
        quote: string,
        _value: string,
        endQuote: string,
      ) => `${open}${key}${close}:${quote}[redacted]${endQuote}`,
    )
    .replace(
      /(["'])(passkey|pass_key|line_up_id|line_up_type)(["']?)\s*:\s*(["'])(.*?)\4/gi,
      (_match, open: string, key: string, close: string, quote: string) =>
        `${open}${key}${close}:${quote}[redacted]${quote}`,
    );
}
