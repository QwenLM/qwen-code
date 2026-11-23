/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableModel } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { resolveModelId } from '@qwen-code/qwen-code-core/utils/modelId.js';
import { parseVisionModelSetting } from '@qwen-code/qwen-code-core/config/config.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE } from '@qwen-code/qwen-code-core/qwen/subscription-errors.js';
import { t } from '../i18n/index.js';
import { formatAuxModelSelectorForDisplay } from '../utils/aux-model-selector.js';

export type VoiceTransport =
  | 'qwen-asr-chat'
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime'
  | 'unsupported';

/** Map a model id to the ASR transport it uses, or 'unsupported'. */
export function resolveVoiceTransport(model: string): VoiceTransport {
  let selector;
  try {
    selector = resolveModelId(model);
  } catch {
    return 'unsupported';
  }
  if (selector?.authType === AuthType.QWEN_SUBSCRIPTION) return 'qwen-asr-chat';
  const id = selector?.modelId.toLowerCase() ?? '';
  if (/^qwen3-asr-flash-realtime(?:-|$)/.test(id)) {
    return 'qwen-asr-realtime';
  }
  if (/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return 'qwen-asr-chat';
  }
  if (/^(fun-asr|paraformer).*realtime(?:-|$)/.test(id)) {
    return 'dashscope-task-realtime';
  }
  return 'unsupported';
}

export function findVoiceModels(
  models: AvailableModel[],
  setting: string,
): AvailableModel[] {
  const parsed = parseVisionModelSetting(setting);
  let selector;
  try {
    selector = resolveModelId(parsed?.selector);
  } catch {
    return [];
  }
  if (!selector) return [];
  return models.filter(
    (model) =>
      model.id === selector.modelId &&
      (!selector.authType || model.authType === selector.authType) &&
      (!parsed?.baseUrl || model.baseUrl === parsed.baseUrl),
  );
}

export function getVoiceModelSelector(model: AvailableModel): string {
  const selector = `${model.authType}:${model.id}`;
  return model.authType !== AuthType.QWEN_SUBSCRIPTION && model.baseUrl
    ? `${selector}\0${model.baseUrl}`
    : selector;
}

export function assertVoiceModelSignedIn(setting: string): void {
  let selector;
  try {
    selector = resolveModelId(setting);
  } catch {
    return;
  }
  if (
    selector?.authType === AuthType.QWEN_SUBSCRIPTION &&
    !new QwenSubscriptionSession().isSignedIn()
  ) {
    throw new SubscriptionOAuthError(
      'session_changed',
      401,
      SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE,
    );
  }
}

export function resolveVoiceModelTransport(
  model: AvailableModel,
): VoiceTransport {
  if (model.authType === AuthType.QWEN_SUBSCRIPTION) {
    return model.subscriptionScenes?.includes('voice')
      ? 'qwen-asr-chat'
      : 'unsupported';
  }
  return resolveVoiceTransport(model.id);
}

/**
 * A model that can be used as a voice transcription provider: an OpenAI-compatible
 * or advertised subscription model with a baseUrl. Transport-agnostic — the record-time
 * config resolver also uses this and then enforces the exact baseUrl/transport rules.
 */
export function isTranscribableVoiceModel(model: AvailableModel): boolean {
  return (
    (model.authType === AuthType.USE_OPENAI ||
      (model.authType === AuthType.QWEN_SUBSCRIPTION &&
        model.subscriptionScenes?.includes('voice') === true)) &&
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
    resolveVoiceModelTransport(model) !== 'unsupported'
  );
}

export function formatUnsupportedVoiceModelMessage(modelName: string): string {
  return t(
    "Voice model '{{modelName}}' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.",
    {
      modelName: formatAuxModelSelectorForDisplay(modelName),
    },
  );
}
