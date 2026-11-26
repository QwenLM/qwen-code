/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 推理协议标识。品牌化字符串：只有经本模块导出常量标注的字符串才是合法协议，
 * core 不枚举协议全集，品牌协议常量（如远程协议）由归属包自带。
 */
declare const modelProtocol: unique symbol;
export type ModelProtocol = string & {
  readonly [modelProtocol]: 'ModelProtocol';
};

/** core 本就知晓的三种开源推理协议常量。 */
export const OPENAI_CHAT_COMPLETIONS =
  'openai-chat-completions' as ModelProtocol;
export const OPENAI_RESPONSES = 'openai-responses' as ModelProtocol;
export const ANTHROPIC_MESSAGES = 'anthropic-messages' as ModelProtocol;
export const GOOGLE_GEMINI = 'gemini' as ModelProtocol;
