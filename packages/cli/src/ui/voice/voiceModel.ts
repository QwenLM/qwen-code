/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type AvailableModel } from '@qwen-code/qwen-code-core';

export function isTranscribableVoiceModel(model: AvailableModel): boolean {
  return (
    model.authType === AuthType.USE_OPENAI &&
    model.isRuntimeModel !== true &&
    typeof model.baseUrl === 'string' &&
    model.baseUrl.trim().length > 0
  );
}

export function formatUnsupportedVoiceModelMessage(modelName: string): string {
  return (
    `Voice model '${modelName}' cannot be used for transcription. ` +
    'Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.'
  );
}
