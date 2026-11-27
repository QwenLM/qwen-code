/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../utils/auth-type.js';
import { DashScopeOpenAICompatibleProvider } from '../openaiContentGenerator/provider/dashscope.js';

export type ResponsesWireDialectName = 'openai' | 'dashscope';

export type ResponsesInlineAudioEncoding = 'raw_base64' | 'data_uri';

/**
 * Pure declarative wire-capability descriptor for an OpenAI Responses API
 * endpoint. Keeps `responses-converter.ts` free of vendor-name conditionals
 * and allows future Responses endpoints (e.g. vLLM, SGLang, Azure, xAI) to
 * declare their wire quirks without an OOP provider hierarchy.
 */
export interface ResponsesWireDialect {
  readonly name: ResponsesWireDialectName;
  /**
   * Wire encoding for inline `input_audio.data`:
   * - `'raw_base64'`: standard OpenAI Responses API (no `data:` URI prefix)
   * - `'data_uri'`: DashScope-compatible Responses API (`data:<mime>;base64,...`)
   */
  readonly inlineAudioEncoding: ResponsesInlineAudioEncoding;
  /**
   * Audio format tokens accepted on `input_audio.format` (validated on inline
   * audio and, when `supportsFileAudio` is true, on `fileData` audio parts).
   */
  readonly inlineAudioFormats: ReadonlySet<string>;
  /**
   * Whether `fileData` audio references may be serialized as `input_audio`
   * (`audio_url` or `data:` URI).
   */
  readonly supportsFileAudio: boolean;
  /**
   * Whether inline and `fileData` video parts may be serialized as
   * `input_video`.
   */
  readonly supportsInputVideo: boolean;
  /**
   * Whether unsigned plaintext reasoning items (`{ id, plaintext: true }`) may
   * be replayed directly as `type: 'reasoning'` items instead of degrading to
   * a plain assistant message.
   */
  readonly supportsPlaintextReasoningReplay: boolean;
  /**
   * Whether `tool_choice: 'required'` must be downgraded to `'auto'` when
   * reasoning is active for Qwen-family wire models.
   */
  readonly downgradeRequiredToolChoiceOnReasoning: boolean;
  /**
   * Whether the endpoint supports the `x-dashscope-ossresourceresolve: enable`
   * header to resolve `oss://` media URIs.
   */
  readonly supportsOssResourceResolveHeader: boolean;
}

const OPENAI_INLINE_AUDIO_FORMATS: ReadonlySet<string> = new Set([
  'wav',
  'mp3',
]);

const DASHSCOPE_INLINE_AUDIO_FORMATS: ReadonlySet<string> = new Set([
  'wav',
  'mp3',
  'aac',
  'flac',
  'ogg',
  'm4a',
  'webm',
]);

/**
 * Strict OpenAI Responses API dialect (`api.openai.com` and default for
 * unknown/generic Responses endpoints).
 */
export const OPENAI_RESPONSES_DIALECT: ResponsesWireDialect = Object.freeze({
  name: 'openai',
  inlineAudioEncoding: 'raw_base64',
  inlineAudioFormats: OPENAI_INLINE_AUDIO_FORMATS,
  supportsFileAudio: false,
  supportsInputVideo: false,
  supportsPlaintextReasoningReplay: false,
  downgradeRequiredToolChoiceOnReasoning: false,
  supportsOssResourceResolveHeader: false,
});

/**
 * DashScope-compatible Responses API dialect (DashScope regional hosts,
 * Model Studio / QwenCloud MaaS, and configured `DASHSCOPE_PROXY_BASE_URL`).
 */
export const DASHSCOPE_RESPONSES_DIALECT: ResponsesWireDialect = Object.freeze({
  name: 'dashscope',
  inlineAudioEncoding: 'data_uri',
  inlineAudioFormats: DASHSCOPE_INLINE_AUDIO_FORMATS,
  supportsFileAudio: true,
  supportsInputVideo: true,
  supportsPlaintextReasoningReplay: true,
  downgradeRequiredToolChoiceOnReasoning: true,
  supportsOssResourceResolveHeader: true,
});

/**
 * Resolve the immutable `ResponsesWireDialect` for a target Responses `baseUrl`
 * (honoring `DASHSCOPE_PROXY_BASE_URL` via `isDashScopeProvider()`).
 *
 * Unset/empty `baseUrl` always resolves to strict `OPENAI_RESPONSES_DIALECT`
 * (unlike Chat Completions' `isDashScopeProvider()`, which treats an omitted
 * `baseUrl` as DashScope).
 */
export function resolveResponsesWireDialect(
  baseUrl?: string,
): ResponsesWireDialect {
  if (!baseUrl) {
    return OPENAI_RESPONSES_DIALECT;
  }
  return DashScopeOpenAICompatibleProvider.isDashScopeProvider({
    authType: AuthType.USE_OPENAI_RESPONSES,
    baseUrl,
  })
    ? DASHSCOPE_RESPONSES_DIALECT
    : OPENAI_RESPONSES_DIALECT;
}
