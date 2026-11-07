/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type AvailableModel } from '@qwen-code/qwen-code-core';
import { t } from '../i18n/index.js';

export type VoiceTransport =
  | 'qwen-asr-chat'
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime'
  | 'unsupported';

/**
 * Map a model id to the ASR transport it uses, or 'unsupported'.
 *
 * The `qwen-audio-<version>` family (Model Studio Token Plan, #10932) follows
 * the same split as `qwen3-asr-flash`: `*-realtime` and `*-asr-flash-streaming`
 * ids speak the OpenAI realtime WebSocket dialect, while bare and date-suffixed
 * `*-asr-flash` ids use the batch chat/completions shape. Other ids in the
 * family (filetrans, tts) are not dictation transports and stay unsupported.
 */
export function resolveVoiceTransport(model: string): VoiceTransport {
  const id = model.toLowerCase();
  if (/^qwen3-asr-flash-realtime(?:-|$)/.test(id)) {
    return 'qwen-asr-realtime';
  }
  if (/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return 'qwen-asr-chat';
  }
  if (
    /^qwen-audio-[\d.]+-(?:asr-flash-(?:realtime|streaming)|realtime)(?:-|$)/.test(
      id,
    )
  ) {
    return 'qwen-asr-realtime';
  }
  if (/^qwen-audio-[\d.]+-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return 'qwen-asr-chat';
  }
  if (/^(fun-asr|paraformer).*realtime(?:-|$)/.test(id)) {
    return 'dashscope-task-realtime';
  }
  return 'unsupported';
}

/**
 * A model that can be used as a voice transcription provider: an OpenAI-compatible,
 * non-runtime model with a baseUrl. Transport-agnostic on purpose — the record-time
 * config resolver also uses this and then enforces the exact baseUrl/transport rules.
 */
export function isTranscribableVoiceModel(model: AvailableModel): boolean {
  return (
    model.authType === AuthType.USE_OPENAI &&
    model.isRuntimeModel !== true &&
    model.imageOnly !== true &&
    typeof model.baseUrl === 'string' &&
    model.baseUrl.trim().length > 0
  );
}

/**
 * Selection guard for `/model --voice` and the model dialog: transcribable AND a
 * model id we actually have an ASR transport for. This stops a non-ASR id (e.g. a
 * chat model picked by mistake) from being persisted as the voice model, where it
 * would report "enabled" in /voice status yet throw on every dictation.
 */
export function isSelectableVoiceModel(model: AvailableModel): boolean {
  return (
    isTranscribableVoiceModel(model) &&
    resolveVoiceTransport(model.id) !== 'unsupported'
  );
}

export function formatUnsupportedVoiceModelMessage(modelName: string): string {
  return t(
    "Voice model '{{modelName}}' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.",
    {
      modelName,
    },
  );
}
