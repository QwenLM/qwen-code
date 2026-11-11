/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview NDJSON 安全序列化。
 *
 * JSON.stringify 会原样输出 U+2028/U+2029（符合 ECMA-404），
 * 但在行分割的 NDJSON 场景下，任何使用 JavaScript 行终止符语义
 * （ECMA-262 §11.3 — \n \r U+2028 U+2029）的接收方都会把 JSON
 * 字符串截断。
 *
 * \uXXXX 转义形式是等价的 JSON（解析结果相同），但不会被任何
 * 接收方误认为行终止符。
 */

// 单个正则 + 交替：每次匹配的回调分发比两次全字符串扫描更快
const JS_LINE_TERMINATORS = /\u2028|\u2029/g;

function escapeJsLineTerminators(json: string): string {
  return json.replace(JS_LINE_TERMINATORS, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

/**
 * 面向 NDJSON 传输的 JSON.stringify。
 *
 * 转义 U+2028 LINE SEPARATOR 和 U+2029 PARAGRAPH SEPARATOR，
 * 确保序列化输出不会被行分割接收方截断。输出仍然是合法 JSON，
 * 解析结果与原值一致。
 */
export function ndjsonSafeStringify(value: unknown): string {
  return escapeJsLineTerminators(JSON.stringify(value));
}
